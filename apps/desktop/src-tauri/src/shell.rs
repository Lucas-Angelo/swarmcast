//! The shell's state machine: server lifecycle, window, splash, quitting.
//!
//! Locking rule: `Inner` is never held while calling into the window, tray or dialogs
//! (they may wait for the main thread, which may be waiting for `Inner`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::i18n::{self, t, tr};
use crate::logs;
use crate::protocol::{ClickId, LiveState, Phase, ServerMessage, ShellMessage, UpdateInfo, UpdateStatus};
use crate::sidecar::{Layout, Process, SpawnEnv};
use crate::tray::{self, TrayView};
use crate::updater;

/// Restarts before `ready`: up to 3, after these delays. Then the splash shows the error.
pub const RESTART_DELAYS: [Duration; 3] = [Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(10)];
/// How long the server gets to stop the live and exit after `quit`.
pub const QUIT_GRACE: Duration = Duration::from_secs(35);
/// A server that stayed up this long gets a fresh set of restarts when it crashes.
const STABLE_AFTER: Duration = Duration::from_secs(60);

pub const MAIN_WINDOW: &str = "main";

/// What the splash page shows. Texts are already localized.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Splash {
    /// `busy` (spinner / progress) or `error` (Try again + Open logs folder).
    pub state: &'static str,
    pub title: String,
    pub detail: String,
    pub progress: Option<f64>,
}

impl Splash {
    pub fn busy(title: String, detail: String) -> Self {
        Splash { state: "busy", title, detail, progress: None }
    }
    pub fn error(title: String, detail: String) -> Self {
        Splash { state: "error", title, detail, progress: None }
    }
    fn starting() -> Self {
        Splash::busy(t("splash.starting"), t("splash.hint"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Running,
    Quitting,
    Updating,
}

struct Inner {
    process: Option<Arc<Process>>,
    /// Incremented on every spawn, so a late exit of an old process is ignored.
    generation: u64,
    ready_at: Option<Instant>,
    admin_url: Option<Url>,
    live: Option<LiveState>,
    fatal: Option<(String, String)>,
    attempts: usize,
    mode: Mode,
    splash: Splash,
    update: UpdateInfo,
    close_dialog_open: bool,
}

pub struct Shell {
    pub app: AppHandle,
    layout: Layout,
    env: SpawnEnv,
    inner: Mutex<Inner>,
    /// Origin of the admin panel, read by the navigation handler on the main thread.
    admin_origin: Arc<RwLock<Option<url::Origin>>>,
    splash_url: RwLock<Option<Url>>,
    has_tray: RwLock<bool>,
}

impl Shell {
    /// `no_autostart`: the app was started at login (`--background`), see `SpawnEnv`.
    pub fn new(app: &AppHandle, no_autostart: bool) -> tauri::Result<Arc<Shell>> {
        let exe = std::env::current_exe()?;
        let exe_dir = exe.parent().map(PathBuf::from).unwrap_or_default();
        let resource_dir = app.path().resource_dir().unwrap_or_else(|_| exe_dir.clone());
        let layout = Layout::new(&exe_dir, &resource_dir);
        // AppImage: the running binary lives in a temporary mount; autostart must use the file.
        let desktop_exe = std::env::var_os("APPIMAGE").map(PathBuf::from).unwrap_or(exe);
        let version = app.package_info().version.to_string();
        let env = SpawnEnv { desktop_exe, version: version.clone(), locale: i18n::locale().to_string(), no_autostart };
        logs::shell(format!(
            "SwarmCast desktop {version} starting (locale {}, sidecar {}, resources {})",
            env.locale,
            layout.sidecar.display(),
            resource_dir.display()
        ));
        Ok(Arc::new(Shell {
            app: app.clone(),
            layout,
            env,
            inner: Mutex::new(Inner {
                process: None,
                generation: 0,
                ready_at: None,
                admin_url: None,
                live: None,
                fatal: None,
                attempts: 0,
                mode: Mode::Running,
                splash: Splash::starting(),
                update: UpdateInfo { current: version, ..Default::default() },
                close_dialog_open: false,
            }),
            admin_origin: Arc::new(RwLock::new(None)),
            splash_url: RwLock::new(None),
            has_tray: RwLock::new(false),
        }))
    }

    pub fn version(&self) -> &str {
        &self.env.version
    }

    pub fn admin_origin(&self) -> Arc<RwLock<Option<url::Origin>>> {
        self.admin_origin.clone()
    }

    pub fn set_splash_url(&self, url: Url) {
        *self.splash_url.write().unwrap() = Some(url);
    }

    pub fn set_has_tray(&self, has: bool) {
        *self.has_tray.write().unwrap() = has;
    }

    pub fn mode(&self) -> Mode {
        self.inner.lock().unwrap().mode
    }

    pub fn phase(&self) -> Option<Phase> {
        self.inner.lock().unwrap().live.as_ref().map(|l| l.phase)
    }

    /// True when the live is not off (starting, waiting for OBS, live, stopping).
    pub fn live_is_on(&self) -> bool {
        matches!(self.phase(), Some(p) if p != Phase::Off)
    }

    pub fn splash(&self) -> Splash {
        self.inner.lock().unwrap().splash.clone()
    }

    // ---- server lifecycle ----

    /// Starts the server (no-op if one is running).
    pub fn start(self: &Arc<Self>) {
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            if inner.process.is_some() || inner.mode != Mode::Running {
                return;
            }
            inner.generation += 1;
            inner.fatal = None;
            inner.generation
        };
        if !self.layout.sidecar.exists() {
            logs::shell(format!("server not found at {}", self.layout.sidecar.display()));
            let file = self.layout.sidecar.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            self.show_splash(Splash::error(t("splash.failed_title"), tr("splash.missing", &[("file", &file)])));
            return;
        }
        let on_message = {
            let shell = self.clone();
            move |msg| shell.on_message(generation, msg)
        };
        let on_exit = {
            let shell = self.clone();
            move |code| shell.on_exit(generation, code)
        };
        match Process::spawn(&self.layout, &self.env, on_message, on_exit) {
            Ok(process) => {
                logs::shell(format!("server started (pid {})", process.pid));
                let mut inner = self.inner.lock().unwrap();
                // A server that died at once already ran `on_exit` (or is about to: it marks
                // itself exited before taking this lock); do not keep it as the running one.
                if inner.generation == generation && !process.has_exited() {
                    inner.process = Some(process);
                }
            }
            Err(err) => {
                logs::shell(format!("could not start the server: {err}"));
                // Same bounded retries as a crash before `ready`.
                self.after_exit(None, false);
            }
        }
        self.refresh_tray();
    }

    fn on_message(self: &Arc<Self>, generation: u64, msg: ServerMessage) {
        if self.inner.lock().unwrap().generation != generation {
            return;
        }
        match msg {
            ServerMessage::Ready { admin_url, version } => self.on_ready(&admin_url, &version),
            ServerMessage::State(state) => {
                self.inner.lock().unwrap().live = Some(state);
                self.refresh_tray();
            }
            ServerMessage::Fatal { code, message } => {
                logs::shell(format!("server reported a fatal error: {code}: {message}"));
                self.inner.lock().unwrap().fatal = Some((code, message));
            }
            ServerMessage::UpdateCheck => updater::check_soon(self.clone(), true),
            ServerMessage::UpdateInstall => updater::install_soon(self.clone()),
        }
    }

    fn on_ready(self: &Arc<Self>, admin_url: &str, version: &str) {
        let Ok(url) = Url::parse(admin_url) else {
            logs::shell(format!("ignoring ready with an invalid adminUrl: {admin_url}"));
            return;
        };
        if !matches!(url.scheme(), "http" | "https") {
            logs::shell(format!("ignoring ready with a non-http adminUrl: {admin_url}"));
            return;
        }
        logs::shell(format!("server {version} ready, opening the panel"));
        *self.admin_origin.write().unwrap() = Some(url.origin());
        let update = {
            let mut inner = self.inner.lock().unwrap();
            inner.ready_at = Some(Instant::now());
            inner.admin_url = Some(url.clone());
            inner.attempts = 0;
            inner.live.get_or_insert_with(LiveState::default);
            inner.update.clone()
        };
        // The panel shows the update banner from the last status (e.g. after a failed update).
        if update.status != UpdateStatus::None {
            self.send(&ShellMessage::Update(update));
        }
        // `/auth/<token>` answers with a page that sets the panel cookie and then opens `/`
        // from the panel's own origin, so the SameSite=Strict cookie is sent although this
        // navigation starts on the splash.
        if let Some(window) = self.window() {
            if let Err(err) = window.navigate(url) {
                logs::shell(format!("could not open the panel: {err}"));
            }
        }
        self.refresh_tray();
    }

    fn on_exit(self: &Arc<Self>, generation: u64, code: Option<i32>) {
        let (mode, was_stable, had_ready) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != generation {
                return;
            }
            inner.process = None;
            inner.live = None;
            inner.admin_url = None;
            let ready_at = inner.ready_at.take();
            (inner.mode, ready_at.is_some_and(|t| t.elapsed() >= STABLE_AFTER), ready_at.is_some())
        };
        *self.admin_origin.write().unwrap() = None;
        logs::shell(format!("server exited (code {})", code.map_or("none".into(), |c| c.to_string())));
        self.refresh_tray();
        if mode != Mode::Running {
            // Quitting / updating: whoever stopped it carries on.
            return;
        }
        if had_ready && code == Some(0) {
            // The panel's "Quit SwarmCast": the server stopped everything and exited by itself.
            logs::shell("the server quit by itself (panel Quit), closing the app");
            self.inner.lock().unwrap().mode = Mode::Quitting;
            self.app.exit(0);
            return;
        }
        if was_stable {
            self.inner.lock().unwrap().attempts = 0;
        }
        self.after_exit(code, had_ready);
    }

    /// Unexpected exit (or failed spawn): restart with backoff, or show the error.
    fn after_exit(self: &Arc<Self>, _code: Option<i32>, had_ready: bool) {
        let (fatal, attempts) = {
            let inner = self.inner.lock().unwrap();
            (inner.fatal.clone(), inner.attempts)
        };
        if let Some((code, message)) = fatal {
            // A deterministic failure (ports in use…): retrying right away would fail the same way.
            let key = format!("fatal.{code}");
            let message = if message.is_empty() { code.clone() } else { message };
            let detail = tr(if !code.is_empty() && i18n::has(&key) { &key } else { "fatal.generic" }, &[("message", &message)]);
            self.show_splash(Splash::error(t("fatal.title"), detail));
            self.show_window();
            return;
        }
        if attempts >= RESTART_DELAYS.len() {
            logs::shell("server keeps exiting, giving up (splash shows Try again)");
            self.show_splash(Splash::error(t("splash.failed_title"), t("splash.failed")));
            self.show_window();
            return;
        }
        let delay = RESTART_DELAYS[attempts];
        let n = attempts + 1;
        self.inner.lock().unwrap().attempts = n;
        let title = if had_ready {
            t("splash.crashed")
        } else {
            tr("splash.restarting", &[("n", &n.to_string()), ("max", &RESTART_DELAYS.len().to_string())])
        };
        self.show_splash(Splash::busy(title, t("splash.hint")));
        logs::shell(format!("restarting the server in {}s (attempt {n})", delay.as_secs()));
        let shell = self.clone();
        thread::spawn(move || {
            thread::sleep(delay);
            shell.start();
        });
    }

    /// Splash "Try again".
    pub fn retry(self: &Arc<Self>) {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.process.is_some() || inner.mode != Mode::Running {
                return;
            }
            inner.attempts = 0;
        }
        logs::shell("Try again clicked");
        self.show_splash(Splash::starting());
        self.start();
    }

    /// Sends a message to the server; false if it is not running.
    pub fn send(&self, msg: &ShellMessage) -> bool {
        let process = self.inner.lock().unwrap().process.clone();
        process.is_some_and(|p| p.send(msg))
    }

    pub fn set_update(&self, info: UpdateInfo) {
        self.inner.lock().unwrap().update = info.clone();
        self.send(&ShellMessage::Update(info));
    }

    pub fn click(&self, id: ClickId) {
        logs::shell(format!("tray click {id:?}"));
        self.send(&ShellMessage::Click { id });
    }

    /// Stops the server (blocking, up to `QUIT_GRACE` + kill) and enters `mode`.
    /// Returns false if another stop is already in progress.
    pub fn stop_server(&self, mode: Mode) -> bool {
        let process = {
            let mut inner = self.inner.lock().unwrap();
            if inner.mode != Mode::Running {
                return false;
            }
            inner.mode = mode;
            inner.process.clone()
        };
        if let Some(process) = process {
            logs::shell(format!("stopping the server (pid {})", process.pid));
            process.quit(QUIT_GRACE);
        }
        true
    }

    /// Back to normal after a failed update: restart the server.
    pub fn resume(self: &Arc<Self>) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.mode = Mode::Running;
            inner.attempts = 0;
        }
        self.show_splash(Splash::starting());
        self.start();
    }

    // ---- quitting ----

    /// Quit from the tray, the app menu (Cmd+Q) or the window's close button.
    /// `from_window`: the close button, where "keep running" hides the window.
    pub fn request_quit(self: &Arc<Self>, from_window: bool) {
        if self.mode() == Mode::Quitting {
            return;
        }
        if !self.live_is_on() {
            self.quit();
            return;
        }
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.close_dialog_open {
                return;
            }
            inner.close_dialog_open = true;
        }
        let stop = t("close.stop_quit");
        let keep = t("close.keep");
        let shell = self.clone();
        let mut dialog = self
            .app
            .dialog()
            .message(t("close.message"))
            .title("SwarmCast")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(stop.clone(), keep));
        let was_visible = self.window().is_some_and(|w| w.is_visible().unwrap_or(false));
        if let Some(window) = self.dialog_window() {
            dialog = dialog.parent(&window);
        }
        dialog.show_with_result(move |result| {
            shell.inner.lock().unwrap().close_dialog_open = false;
            let stop_clicked = matches!(&result, MessageDialogResult::Ok | MessageDialogResult::Yes)
                || matches!(&result, MessageDialogResult::Custom(label) if *label == stop);
            if stop_clicked {
                shell.quit();
            } else if from_window || !was_visible {
                shell.hide_window();
            }
        });
    }

    /// Stops everything and exits.
    pub fn quit(self: &Arc<Self>) {
        let visible = self.window().is_some_and(|w| w.is_visible().unwrap_or(false));
        let shell = self.clone();
        thread::spawn(move || {
            if !shell.stop_server_for_quit(visible) {
                return;
            }
            logs::shell("bye");
            shell.app.exit(0);
        });
    }

    fn stop_server_for_quit(&self, visible: bool) -> bool {
        if self.mode() != Mode::Running {
            return false;
        }
        logs::shell("quitting");
        if visible && self.inner.lock().unwrap().process.is_some() {
            self.show_splash(Splash::busy(t("splash.stopping"), t("splash.stopping_hint")));
        }
        self.stop_server(Mode::Quitting)
    }

    // ---- window ----

    pub fn window(&self) -> Option<WebviewWindow> {
        self.app.get_webview_window(MAIN_WINDOW)
    }

    pub fn show_window(&self) {
        let Some(window) = self.window() else { return };
        #[cfg(target_os = "macos")]
        let _ = self.app.set_dock_visibility(true);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    /// The window, shown, to carry a dialog. macOS dialogs are sheets: without a visible parent
    /// they would attach to a hidden window and never appear (e.g. started with --background).
    pub fn dialog_window(&self) -> Option<WebviewWindow> {
        self.show_window();
        self.window()
    }

    pub fn hide_window(&self) {
        let Some(window) = self.window() else { return };
        if !*self.has_tray.read().unwrap() {
            // Without a tray icon a hidden window could not be reopened.
            let _ = window.minimize();
            return;
        }
        let _ = window.hide();
        #[cfg(target_os = "macos")]
        let _ = self.app.set_dock_visibility(false);
    }

    fn is_on_splash(&self, window: &WebviewWindow) -> bool {
        let Ok(current) = window.url() else { return false };
        let splash = self.splash_url.read().unwrap();
        splash.as_ref().is_some_and(|s| s.scheme() == current.scheme() && s.host_str() == current.host_str())
    }

    /// Shows `splash` on the splash page (navigating back to it if the panel is open).
    pub fn show_splash(&self, splash: Splash) {
        self.inner.lock().unwrap().splash = splash.clone();
        let Some(window) = self.window() else { return };
        if self.is_on_splash(&window) {
            let json = serde_json::to_string(&splash).unwrap_or_default();
            let _ = window.eval(format!("window.swarmcastSplash && window.swarmcastSplash({json})"));
        } else if let Some(url) = self.splash_url.read().unwrap().clone() {
            // The page asks for the current status when it loads.
            let _ = window.navigate(url);
        }
    }

    /// Updates only the progress bar (download progress).
    pub fn splash_progress(&self, progress: Option<f64>) {
        let splash = {
            let mut inner = self.inner.lock().unwrap();
            inner.splash.progress = progress;
            inner.splash.clone()
        };
        if let Some(window) = self.window().filter(|w| self.is_on_splash(w)) {
            let json = serde_json::to_string(&splash).unwrap_or_default();
            let _ = window.eval(format!("window.swarmcastSplash && window.swarmcastSplash({json})"));
        }
    }

    pub fn open_logs(&self) {
        let dir = logs::logs_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Err(err) = self.app.opener().open_path(dir.to_string_lossy(), None::<&str>) {
            logs::shell(format!("could not open the logs folder: {err}"));
        }
    }

    // ---- tray ----

    pub fn refresh_tray(&self) {
        let view = {
            let inner = self.inner.lock().unwrap();
            match (&inner.admin_url, &inner.live) {
                (Some(_), Some(live)) => TrayView::from_live(live),
                _ => TrayView::starting(),
            }
        };
        tray::update(&self.app, &view);
    }
}

/// Opens `url` in the default browser (or only logs it with `SWARMCAST_NO_OPEN=1`, for tests).
pub fn open_external(app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        logs::shell(format!("blocked a link with scheme {}", url.scheme()));
        return;
    }
    if std::env::var("SWARMCAST_NO_OPEN").is_ok_and(|v| v == "1") {
        logs::shell(format!("would open in the browser: {url}"));
        return;
    }
    logs::shell(format!("opening in the browser: {url}"));
    if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
        logs::shell(format!("could not open {url}: {err}"));
    }
}

// ---- splash commands (local splash page only: see capabilities/main.json) ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplashStatus {
    #[serde(flatten)]
    splash: Splash,
    lang: &'static str,
    texts: serde_json::Map<String, serde_json::Value>,
}

#[tauri::command]
pub fn splash_status(shell: tauri::State<'_, Arc<Shell>>) -> SplashStatus {
    SplashStatus { splash: shell.splash(), lang: i18n::locale(), texts: i18n::splash_texts() }
}

#[tauri::command]
pub fn splash_retry(shell: tauri::State<'_, Arc<Shell>>) {
    let shell = shell.inner().clone();
    if shell.mode() == Mode::Updating {
        return;
    }
    shell.retry();
}

#[tauri::command]
pub fn splash_open_logs(shell: tauri::State<'_, Arc<Shell>>) {
    shell.open_logs();
}
