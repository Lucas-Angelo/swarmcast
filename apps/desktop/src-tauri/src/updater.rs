//! OBS-style updates (docs/DESKTOP.md, "Updates").
//!
//! The Tauri updater fetches `latest.json`, verifies the Ed25519 (minisign) signature of the
//! package against the public key in tauri.conf.json, installs it and we relaunch. Settings
//! live in the data folder, which no installer touches.
//!
//! Platforms: Windows NSIS (passive installer, relaunches the app), macOS (replaces the .app),
//! Linux AppImage (replaces the file) and .deb (`dpkg -i` through pkexec / a graphical sudo
//! prompt; tauri-plugin-updater ≥ 2.10 supports it).
//!
//! Channels: `stable` reads only the stable feed (the latest GitHub release, never a
//! pre-release). `beta` (the panel's "Get beta versions") reads the stable feed AND the beta feed
//! and offers the higher version, so a stale or broken beta feed never keeps beta users behind
//! stable. Both keep the plugin's default comparator (`version > current`): nothing is ever
//! downgraded, so switching back to stable keeps the beta until a stable version is higher.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};
use url::Url;

use crate::i18n::{t, tr};
use crate::logs;
use crate::protocol::{Channel, UpdateInfo, UpdateStatus};
use crate::shell::{Mode, Shell, Splash};

/// The stable feed: the latest release of the main repository. `/releases/latest/` never points
/// at a pre-release, so only stable versions are offered there. It answers 404 until a release
/// ships `latest.json`; that counts as "up to date".
pub const UPDATE_ENDPOINT: &str = "https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/latest.json";
/// The beta feed, built with the website (scripts/releases/beta-manifest.mjs): a copy of the
/// `latest.json` of the highest release, pre-release or stable.
pub const BETA_ENDPOINT: &str = "https://lucas-angelo.github.io/swarmcast/updates/beta.json";

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
/// The streamer's choice from the panel (`update-channel`); `None` = automatic.
static CHOICE: Mutex<Option<Option<Channel>>> = Mutex::new(None);

/// The channel in use: the streamer's choice, otherwise `beta` when this version is a
/// pre-release (someone who installed 0.3.0-beta.1 by hand follows the betas, and is back on
/// stable by themselves once 0.3.0 is installed), otherwise `stable`.
pub fn resolve(choice: Option<Channel>, current: &str) -> Channel {
    choice.unwrap_or_else(|| match semver::Version::parse(current) {
        Ok(v) if !v.pre.is_empty() => Channel::Beta,
        _ => Channel::Stable,
    })
}

fn channel(shell: &Shell) -> Channel {
    resolve(CHOICE.lock().unwrap().flatten(), shell.version())
}

fn channel_name(channel: Channel) -> &'static str {
    match channel {
        Channel::Stable => "stable",
        Channel::Beta => "beta",
    }
}

/// The feeds a channel reads, from the test overrides when set (`SWARMCAST_UPDATE_URL`,
/// `SWARMCAST_BETA_UPDATE_URL`). `SWARMCAST_UPDATE_URL` alone overrides everything: it is the
/// only feed, whatever the channel (the update tests).
pub fn feeds(channel: Channel, update_url: Option<&str>, beta_url: Option<&str>) -> Vec<String> {
    let stable = update_url.unwrap_or(UPDATE_ENDPOINT).to_string();
    match (channel, update_url, beta_url) {
        (Channel::Stable, _, _) | (Channel::Beta, Some(_), None) => vec![stable],
        (Channel::Beta, _, beta) => vec![stable, beta.unwrap_or(BETA_ENDPOINT).to_string()],
    }
}

/// The feed URLs of `channel`. Plain http only in builds with the `insecure-updates` feature
/// (local update tests); the package signature is checked anyway.
pub fn endpoints(channel: Channel) -> Result<Vec<Url>, String> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let (update_url, beta_url) = (var("SWARMCAST_UPDATE_URL"), var("SWARMCAST_BETA_UPDATE_URL"));
    feeds(channel, update_url.as_deref(), beta_url.as_deref())
        .iter()
        .map(|raw| {
            let url = Url::parse(raw).map_err(|e| format!("invalid update URL: {e}"))?;
            match url.scheme() {
                "https" => Ok(url),
                "http" if cfg!(feature = "insecure-updates") => Ok(url),
                other => Err(format!("update URL must use https (got {other})")),
            }
        })
        .collect()
}

/// Index of the highest version (SemVer); the first one wins a tie. Unparsable versions lose.
pub fn newest<'a>(versions: impl IntoIterator<Item = &'a str>) -> Option<usize> {
    let mut best: Option<(usize, Option<semver::Version>)> = None;
    for (i, v) in versions.into_iter().enumerate() {
        let parsed = semver::Version::parse(v).ok();
        let better = match &best {
            None => true,
            Some((_, b)) => match (&parsed, b) {
                (Some(p), Some(b)) => p > b,
                (Some(_), None) => true,
                _ => false,
            },
        };
        if better {
            best = Some((i, parsed));
        }
    }
    best.map(|(i, _)| i)
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

/// Why a check runs: what it shows besides the panel's status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Trigger {
    /// 10 s after start and every 6 h: a dialog for a version not offered yet.
    Scheduled,
    /// Tray or panel "Check for updates": a dialog in every case.
    Manual,
    /// The streamer changed the channel in the panel: the panel shows the result, no dialog.
    ChannelChanged,
}

/// First check 10 s after start, then every 6 h.
pub fn schedule(shell: Arc<Shell>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(shell.clone(), Trigger::Scheduled).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Tray "Check for updates" (manual) or the panel's button (`update-check`).
pub fn check_soon(shell: Arc<Shell>, manual: bool) {
    tauri::async_runtime::spawn(check(shell, if manual { Trigger::Manual } else { Trigger::Scheduled }));
}

/// The panel's channel (`update-channel`, sent at `ready` and on every change). A change of the
/// channel in use forgets the update found on the other one and checks again right away.
pub fn set_channel(shell: Arc<Shell>, choice: Option<Channel>) {
    let (before, after) = {
        let mut stored = CHOICE.lock().unwrap();
        let before = resolve(stored.flatten(), shell.version());
        *stored = Some(choice);
        (before, resolve(choice, shell.version()))
    };
    let how = if choice.is_some() { "chosen in the panel" } else { "automatic" };
    logs::shell(format!("update channel: {} ({how})", channel_name(after)));
    if before == after {
        return;
    }
    *PENDING.lock().unwrap() = None;
    tauri::async_runtime::spawn(async move {
        // A check that is running uses the old channel: wait for it (at most twice its timeout).
        for _ in 0..(REQUEST_TIMEOUT.as_millis() * 2 / 250) {
            if !BUSY.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        check(shell, Trigger::ChannelChanged).await;
    });
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

/// Asks one feed. 404 (no release with `latest.json` yet) and a manifest without this platform
/// both mean "no update" from that feed.
async fn check_feed(app: AppHandle, url: Url) -> Result<Option<Update>, String> {
    let updater = app
        .updater_builder()
        .endpoints(vec![url.clone()])
        .map_err(|e| e.to_string())?
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(update) => Ok(update),
        Err(UpdaterError::ReleaseNotFound) => {
            logs::shell(format!("update check: no release published at {url} (up to date)"));
            Ok(None)
        }
        Err(UpdaterError::TargetNotFound(t)) => {
            logs::shell(format!("update check: the release at {url} has no package for {t}"));
            Ok(None)
        }
        Err(UpdaterError::TargetsNotFound(t)) => {
            logs::shell(format!("update check: the release at {url} has no package for {}", t.join(" / ")));
            Ok(None)
        }
        Err(err) => Err(format!("{url}: {err}")),
    }
}

/// Asks every feed of the channel at once and keeps the highest version newer than this one.
/// A feed that fails is logged and skipped; only when every feed fails is it an error.
async fn find_with(shell: &Shell) -> Result<Option<Update>, String> {
    let urls = endpoints(channel(shell))?;
    let checks: Vec<_> = urls.into_iter().map(|url| tauri::async_runtime::spawn(check_feed(shell.app.clone(), url))).collect();
    let mut found = Vec::new();
    let mut errors = Vec::new();
    for check in checks {
        match check.await {
            Ok(Ok(update)) => found.extend(update),
            Ok(Err(err)) => errors.push(err),
            Err(err) => errors.push(err.to_string()),
        }
    }
    if found.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    for err in &errors {
        logs::shell(format!("update check: one feed failed, using the others: {err}"));
    }
    Ok(newest(found.iter().map(|u| u.version.as_str())).map(|i| found.swap_remove(i)))
}

async fn check(shell: Arc<Shell>, trigger: Trigger) {
    if shell.mode() != Mode::Running {
        return;
    }
    let Some(busy) = Busy::take() else {
        logs::shell("update check skipped: another check or install is running");
        return;
    };
    let manual = trigger == Trigger::Manual;
    let why = match trigger {
        Trigger::Scheduled => "automatic",
        Trigger::Manual => "manual",
        Trigger::ChannelChanged => "channel changed",
    };
    logs::shell(format!("checking for updates ({why}, {} channel)", channel_name(channel(&shell))));
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
            if manual || (trigger == Trigger::Scheduled && !already_offered) {
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
            // Automatic checks stay silent (offline, firewall…): the next one runs in 6 h. After a
            // channel change the panel waits for an answer, so it gets the error.
            if trigger != Trigger::Scheduled {
                shell.set_update(UpdateInfo { status: UpdateStatus::Error, current, error: Some(err.clone()), ..Default::default() });
            }
            if manual {
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
        assert_eq!(Url::parse(BETA_ENDPOINT).unwrap().scheme(), "https");
        assert_eq!(Url::parse(BETA_ENDPOINT).unwrap().host_str(), Some("lucas-angelo.github.io"));
    }

    #[test]
    fn channel_is_the_choice_else_beta_for_a_prerelease() {
        assert_eq!(resolve(None, "0.2.2"), Channel::Stable);
        assert_eq!(resolve(None, "0.3.0-beta.1"), Channel::Beta);
        assert_eq!(resolve(None, "0.3.0-rc.2"), Channel::Beta);
        assert_eq!(resolve(None, "0.3.0"), Channel::Stable);
        assert_eq!(resolve(Some(Channel::Stable), "0.3.0-beta.1"), Channel::Stable);
        assert_eq!(resolve(Some(Channel::Beta), "0.2.2"), Channel::Beta);
        // Not SemVer (never shipped): stable.
        assert_eq!(resolve(None, "dev"), Channel::Stable);
    }

    #[test]
    fn stable_reads_one_feed_beta_reads_both() {
        assert_eq!(feeds(Channel::Stable, None, None), vec![UPDATE_ENDPOINT]);
        assert_eq!(feeds(Channel::Beta, None, None), vec![UPDATE_ENDPOINT, BETA_ENDPOINT]);
        // SWARMCAST_UPDATE_URL alone overrides everything (the existing update tests).
        assert_eq!(feeds(Channel::Beta, Some("http://127.0.0.1:1/latest.json"), None), vec!["http://127.0.0.1:1/latest.json"]);
        assert_eq!(
            feeds(Channel::Stable, Some("http://127.0.0.1:1/a.json"), Some("http://127.0.0.1:1/b.json")),
            vec!["http://127.0.0.1:1/a.json"]
        );
        assert_eq!(
            feeds(Channel::Beta, Some("http://127.0.0.1:1/a.json"), Some("http://127.0.0.1:1/b.json")),
            vec!["http://127.0.0.1:1/a.json", "http://127.0.0.1:1/b.json"]
        );
        assert_eq!(feeds(Channel::Beta, None, Some("http://127.0.0.1:1/b.json")), vec![UPDATE_ENDPOINT, "http://127.0.0.1:1/b.json"]);
    }

    #[test]
    fn the_highest_version_wins() {
        // Stable newer than a stale beta feed: the stable one.
        assert_eq!(newest(["0.3.0", "0.3.0-beta.2"]), Some(0));
        assert_eq!(newest(["0.2.2", "0.3.0-beta.2"]), Some(1));
        assert_eq!(newest(["0.3.0-beta.11", "0.3.0-beta.2"]), Some(0));
        assert_eq!(newest(["0.3.0-beta.2", "0.3.0-rc.1"]), Some(1));
        // Same version on both feeds: the first (stable) one.
        assert_eq!(newest(["0.3.0", "0.3.0"]), Some(0));
        assert_eq!(newest(["garbage", "0.3.0-beta.1"]), Some(1));
        assert_eq!(newest(Vec::<&str>::new()), None);
    }

    #[test]
    fn no_downgrade_with_the_default_comparator() {
        // What tauri-plugin-updater offers: release.version > current (semver::Version).
        let offered = |release: &str, current: &str| semver::Version::parse(release).unwrap() > semver::Version::parse(current).unwrap();
        assert!(!offered("0.3.0-beta.2", "0.3.0"), "stable 0.3.0 is never offered its own beta");
        assert!(!offered("0.2.2", "0.3.0-beta.1"), "back on stable, the beta stays until a higher stable");
        assert!(offered("0.3.0", "0.3.0-beta.2"));
        assert!(offered("0.3.0-beta.1", "0.2.2"));
        assert!(offered("0.3.0-beta.11", "0.3.0-beta.2"));
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
