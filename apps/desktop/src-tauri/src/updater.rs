//! OBS-style updates (docs/DESKTOP.md, "Updates").
//!
//! The Tauri updater fetches `latest.json`, verifies the Ed25519 (minisign) signature of the
//! package against the public key in tauri.conf.json, installs it and we relaunch. Settings
//! live in the data folder, which no installer touches.
//!
//! Platforms: Windows NSIS (passive installer, relaunches the app), macOS (replaces the .app),
//! Linux AppImage (replaces the file) and .deb (`dpkg -i` through pkexec / a graphical sudo
//! prompt; tauri-plugin-updater ≥ 2.10 supports it).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};
use url::Url;

use crate::i18n::{t, tr};
use crate::logs;
use crate::protocol::{UpdateInfo, UpdateStatus};
use crate::shell::{Mode, Shell, Splash};

/// Where the app looks for updates: the latest release of the main repository.
/// `/releases/latest/` never points at a pre-release, so only stable versions are offered.
/// It answers 404 until a release ships `latest.json`; that counts as "up to date".
pub const UPDATE_ENDPOINT: &str = "https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/latest.json";

const FIRST_CHECK: Duration = Duration::from_secs(10);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// The download is retried after these delays, then the current version keeps running.
const DOWNLOAD_RETRY_DELAYS: [Duration; 3] = [Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(10)];
/// Release notes longer than this are cut in the native dialog (the panel shows them all).
const NOTES_IN_DIALOG: usize = 1200;

/// A check or an install is running.
static BUSY: AtomicBool = AtomicBool::new(false);
static PENDING: Mutex<Option<Update>> = Mutex::new(None);
/// Version already offered by an automatic check (not offered again every 6 h).
static PROMPTED: Mutex<Option<String>> = Mutex::new(None);

/// The endpoint, or `SWARMCAST_UPDATE_URL` (tests). Plain http only in builds with the
/// `insecure-updates` feature (local update tests); the package signature is checked anyway.
pub fn endpoint() -> Result<Url, String> {
    let raw = std::env::var("SWARMCAST_UPDATE_URL").ok().filter(|v| !v.trim().is_empty());
    let url = Url::parse(raw.as_deref().unwrap_or(UPDATE_ENDPOINT)).map_err(|e| format!("invalid update URL: {e}"))?;
    match url.scheme() {
        "https" => Ok(url),
        "http" if cfg!(feature = "insecure-updates") => Ok(url),
        other => Err(format!("update URL must use https (got {other})")),
    }
}

struct Busy;

impl Busy {
    fn take() -> Option<Busy> {
        (!BUSY.swap(true, Ordering::SeqCst)).then_some(Busy)
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// First check 10 s after start, then every 6 h.
pub fn schedule(shell: Arc<Shell>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(shell.clone(), false).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Tray "Check for updates" (manual) or the panel's button (`update-check`).
pub fn check_soon(shell: Arc<Shell>, manual: bool) {
    tauri::async_runtime::spawn(check(shell, manual));
}

/// Panel "Update now" (`update-install`).
pub fn install_soon(shell: Arc<Shell>) {
    tauri::async_runtime::spawn(async move {
        let pending = PENDING.lock().unwrap().clone();
        let update = match pending {
            Some(update) => Some(update),
            None => match find_with(&shell).await {
                Ok(found) => found,
                Err(err) => {
                    logs::shell(format!("update check failed: {err}"));
                    None
                }
            },
        };
        match update {
            Some(update) => install(shell, update).await,
            None => shell.set_update(UpdateInfo { status: UpdateStatus::None, current: shell.version().into(), ..Default::default() }),
        }
    });
}

/// Asks the endpoint. 404 (no release with `latest.json` yet) and a manifest without this
/// platform both mean "no update".
async fn find_with(shell: &Shell) -> Result<Option<Update>, String> {
    let url = endpoint()?;
    let updater = shell
        .app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(update) => Ok(update),
        Err(UpdaterError::ReleaseNotFound) => {
            logs::shell("update check: no release published at the endpoint (up to date)");
            Ok(None)
        }
        Err(UpdaterError::TargetNotFound(t)) => {
            logs::shell(format!("update check: the release has no package for {t}"));
            Ok(None)
        }
        Err(UpdaterError::TargetsNotFound(t)) => {
            logs::shell(format!("update check: the release has no package for {}", t.join(" / ")));
            Ok(None)
        }
        Err(err) => Err(err.to_string()),
    }
}

async fn check(shell: Arc<Shell>, manual: bool) {
    if shell.mode() != Mode::Running {
        return;
    }
    let Some(busy) = Busy::take() else {
        logs::shell("update check skipped: another check or install is running");
        return;
    };
    logs::shell(format!("checking for updates ({})", if manual { "manual" } else { "automatic" }));
    let result = find_with(&shell).await;
    drop(busy);
    let current = shell.version().to_string();
    match result {
        Ok(Some(update)) => {
            logs::shell(format!("update available: {} (current {current})", update.version));
            shell.set_update(UpdateInfo {
                status: UpdateStatus::Available,
                current,
                version: Some(update.version.clone()),
                notes: update.body.clone().filter(|n| !n.trim().is_empty()),
                ..Default::default()
            });
            *PENDING.lock().unwrap() = Some(update.clone());
            let already_offered = PROMPTED.lock().unwrap().as_deref() == Some(update.version.as_str());
            if manual || !already_offered {
                *PROMPTED.lock().unwrap() = Some(update.version.clone());
                prompt(shell, update);
            }
        }
        Ok(None) => {
            logs::shell("no update available");
            *PENDING.lock().unwrap() = None;
            shell.set_update(UpdateInfo { status: UpdateStatus::None, current: current.clone(), ..Default::default() });
            if manual {
                message(&shell, tr("update.latest", &[("current", &current)]), MessageDialogKind::Info);
            }
        }
        Err(err) => {
            logs::shell(format!("update check failed: {err}"));
            // Automatic checks stay silent (offline, firewall…): the next one runs in 6 h.
            if manual {
                shell.set_update(UpdateInfo { status: UpdateStatus::Error, current, error: Some(err.clone()), ..Default::default() });
                message(&shell, tr("update.check_failed", &[("error", &err)]), MessageDialogKind::Warning);
            }
        }
    }
}

fn message(shell: &Shell, text: String, kind: MessageDialogKind) {
    let mut dialog =
        shell.app.dialog().message(text).title(t("update.title")).kind(kind).buttons(MessageDialogButtons::OkCustom(t("update.ok")));
    if let Some(window) = shell.dialog_window() {
        dialog = dialog.parent(&window);
    }
    dialog.show(|_| {});
}

/// The text of the "update available" dialog.
pub fn prompt_text(version: &str, current: &str, notes: Option<&str>, live: bool) -> String {
    let mut text = tr("update.available", &[("version", version), ("current", current)]);
    if live {
        text.push_str("\n\n");
        text.push_str(&t("update.live_warning"));
    }
    if let Some(notes) = notes.map(str::trim).filter(|n| !n.is_empty()) {
        text.push_str("\n\n");
        text.push_str(&t("update.notes"));
        text.push('\n');
        if notes.chars().count() > NOTES_IN_DIALOG {
            text.extend(notes.chars().take(NOTES_IN_DIALOG));
            text.push('…');
        } else {
            text.push_str(notes);
        }
    }
    text
}

/// "SwarmCast X is available (you have Y)" [Update now] [Later]. With the live on, "Later"
/// is the default button (the native default is the first one).
fn prompt(shell: Arc<Shell>, update: Update) {
    let live = shell.live_is_on();
    let text = prompt_text(&update.version, shell.version(), update.body.as_deref(), live);
    let now = t("update.now");
    let later = t("update.later");
    let buttons = if live {
        MessageDialogButtons::OkCancelCustom(later.clone(), now.clone())
    } else {
        MessageDialogButtons::OkCancelCustom(now.clone(), later.clone())
    };
    let target = shell.clone();
    let mut dialog = shell
        .app
        .dialog()
        .message(text)
        .title(t("update.title"))
        .kind(if live { MessageDialogKind::Warning } else { MessageDialogKind::Info })
        .buttons(buttons);
    if let Some(window) = shell.dialog_window() {
        dialog = dialog.parent(&window);
    }
    dialog.show_with_result(move |result| {
        let update_now = match &result {
            MessageDialogResult::Custom(label) => *label == now,
            MessageDialogResult::Ok | MessageDialogResult::Yes => !live,
            _ => false,
        };
        if update_now {
            logs::shell("update accepted");
            tauri::async_runtime::spawn(install(target, update));
        } else {
            logs::shell("update postponed");
        }
    });
}

/// Errors that a new download cannot fix (bad signature, wrong package).
fn is_permanent(err: &UpdaterError) -> bool {
    matches!(
        err,
        UpdaterError::Minisign(_)
            | UpdaterError::SignatureUtf8(_)
            | UpdaterError::Base64(_)
            | UpdaterError::SignedVersionMismatch { .. }
            | UpdaterError::MissingSignedVersion
            | UpdaterError::InvalidUpdaterFormat
            | UpdaterError::InsecureTransportProtocol
    )
}

/// Update now: stop the server, download (with retries), verify, install, relaunch.
async fn install(shell: Arc<Shell>, update: Update) {
    let Some(_busy) = Busy::take() else {
        logs::shell("update install skipped: another check or install is running");
        return;
    };
    let current = shell.version().to_string();
    let info = |status, progress, error: Option<String>| UpdateInfo {
        status,
        current: current.clone(),
        version: Some(update.version.clone()),
        notes: update.body.clone(),
        progress,
        error,
    };
    logs::shell(format!("installing update {} (from {current})", update.version));
    // The panel shows "downloading" until the window switches to the splash.
    shell.set_update(info(UpdateStatus::Downloading, Some(0.0), None));
    shell.show_window();
    shell.show_splash(Splash::busy(t("splash.update_preparing"), t("splash.update_hint")));
    let stopper = shell.clone();
    let stopped = tauri::async_runtime::spawn_blocking(move || stopper.stop_server(Mode::Updating)).await.unwrap_or(false);
    if !stopped {
        logs::shell("update install skipped: SwarmCast is quitting");
        return;
    }

    let mut bytes = None;
    let mut last_error = String::new();
    for attempt in 0..=DOWNLOAD_RETRY_DELAYS.len() {
        if attempt > 0 {
            let max = DOWNLOAD_RETRY_DELAYS.len().to_string();
            shell.show_splash(Splash::busy(
                tr("splash.update_retrying", &[("n", &attempt.to_string()), ("max", &max)]),
                t("splash.update_hint"),
            ));
            tokio::time::sleep(DOWNLOAD_RETRY_DELAYS[attempt - 1]).await;
        }
        let mut splash = Splash::busy(t("splash.update_downloading"), t("splash.update_hint"));
        splash.progress = Some(0.0);
        shell.show_splash(splash);
        let mut received = 0u64;
        let mut shown = -1i64;
        let progress_shell = shell.clone();
        let result = update
            .download(
                |chunk, total| {
                    received += chunk as u64;
                    let Some(total) = total.filter(|t| *t > 0) else { return };
                    let fraction = (received as f64 / total as f64).min(1.0);
                    let pct = (fraction * 100.0) as i64;
                    if pct != shown {
                        shown = pct;
                        progress_shell.splash_progress(Some(fraction));
                    }
                },
                || {},
            )
            .await;
        match result {
            Ok(b) => {
                bytes = Some(b);
                break;
            }
            Err(err) => {
                logs::shell(format!("update download failed (attempt {}): {err}", attempt + 1));
                last_error = err.to_string();
                if is_permanent(&err) {
                    break;
                }
            }
        }
    }
    let Some(bytes) = bytes else {
        fail(&shell, info(UpdateStatus::Error, None, Some(last_error.clone())), &last_error);
        return;
    };

    logs::shell("update downloaded and verified, installing");
    shell.show_splash(Splash::busy(t("splash.update_installing"), t("splash.update_hint")));
    write_relaunch_marker(&update.version);
    let to_install = update.clone();
    // Windows: starts the NSIS installer (passive) and exits this process; NSIS relaunches us.
    let result = tauri::async_runtime::spawn_blocking(move || to_install.install(bytes)).await;
    match result {
        Ok(Ok(())) => {
            logs::shell(format!("update {} installed, relaunching", update.version));
            shell.show_splash(Splash::busy(t("splash.update_restarting"), t("splash.update_hint")));
            relaunch(&shell);
        }
        Ok(Err(err)) => {
            take_relaunch_marker();
            fail(&shell, info(UpdateStatus::Error, None, Some(err.to_string())), &err.to_string());
        }
        Err(err) => {
            take_relaunch_marker();
            fail(&shell, info(UpdateStatus::Error, None, Some(err.to_string())), &err.to_string());
        }
    }
}

/// The current version keeps working: restart the server and tell the user.
fn fail(shell: &Arc<Shell>, info: UpdateInfo, error: &str) {
    logs::shell(format!("update failed: {error}"));
    // Stored now, sent to the panel as soon as the restarted server is ready.
    shell.set_update(info);
    shell.resume();
    message(shell, tr("update.failed", &[("current", shell.version()), ("error", error)]), MessageDialogKind::Warning);
}

fn marker_path() -> std::path::PathBuf {
    crate::logs::data_dir().join("run").join("desktop-updated")
}

/// After an update the app opens its window even if it was running with `--background`
/// (the relaunch reuses the original arguments).
fn write_relaunch_marker(version: &str) {
    let path = marker_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, version);
}

/// True (once) if the previous process just installed an update.
pub fn take_relaunch_marker() -> bool {
    std::fs::remove_file(marker_path()).is_ok()
}

/// Starts the new version once this process is gone, then exits.
///
/// Not `AppHandle::restart()`: on macOS it relaunches through LaunchServices, which drops
/// our environment (`SWARMCAST_DATA_DIR`, `SWARMCAST_UPDATE_URL`…). A tiny `sh` waits for
/// our pid to disappear (so the single-instance lock is free) and then execs the app.
fn relaunch(shell: &Arc<Shell>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        let exe = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from).or_else(|| {
            std::env::current_exe().ok().map(|p| {
                // Linux: /proc/self/exe of a binary replaced by dpkg ends in " (deleted)".
                let s = p.to_string_lossy();
                std::path::PathBuf::from(s.strip_suffix(" (deleted)").unwrap_or(&s).to_string())
            })
        });
        if let Some(exe) = exe {
            let spawned = Command::new("/bin/sh")
                .arg("-c")
                .arg(r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; exec "$@""#)
                .arg("sh")
                .arg(std::process::id().to_string())
                .arg(&exe)
                .args(std::env::args_os().skip(1))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn();
            if let Err(err) = spawned {
                logs::shell(format!("could not relaunch {}: {err}", exe.display()));
            }
        }
        shell.app.exit(0);
    }
    #[cfg(not(unix))]
    shell.app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_endpoint_is_github_latest() {
        assert!(UPDATE_ENDPOINT.starts_with("https://github.com/Lucas-Angelo/swarmcast/releases/latest/"));
        assert_eq!(Url::parse(UPDATE_ENDPOINT).unwrap().scheme(), "https");
    }

    #[test]
    fn prompt_text_has_versions_warning_and_notes() {
        let text = prompt_text("0.3.0", "0.2.0", Some("  Faster start  "), true);
        assert!(text.contains("0.3.0") && text.contains("0.2.0"));
        assert!(text.contains(&t("update.live_warning")));
        assert!(text.ends_with("Faster start"));
        let text = prompt_text("0.3.0", "0.2.0", Some(""), false);
        assert!(!text.contains(&t("update.notes")));
        let long = "x".repeat(NOTES_IN_DIALOG + 50);
        assert!(prompt_text("1", "0", Some(&long), false).ends_with("x…"));
    }
}
