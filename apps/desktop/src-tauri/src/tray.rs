//! Tray / menu bar icon: off / waiting / live icons (same as apps/tray), localized tooltip
//! and menu (Open SwarmCast, Start live, Stop live, Check for updates, Export logs…, Quit).

use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::i18n::{t, tr};
use crate::logs;
use crate::protocol::{ClickId, IconState, LiveState, Phase};
use crate::shell::Shell;
use crate::updater;

const ICON_OFF: &[u8] = include_bytes!("../icons/tray/off.png");
const ICON_WAITING: &[u8] = include_bytes!("../icons/tray/waiting.png");
const ICON_LIVE: &[u8] = include_bytes!("../icons/tray/live.png");

/// What the tray shows.
#[derive(Clone, Debug, PartialEq)]
pub struct TrayView {
    pub icon: IconState,
    pub tooltip: String,
    pub can_start: bool,
    pub can_stop: bool,
}

impl TrayView {
    /// Before the server is ready (or while it restarts).
    pub fn starting() -> Self {
        TrayView { icon: IconState::Off, tooltip: t("tooltip.starting_app"), can_start: false, can_stop: false }
    }

    pub fn from_live(live: &LiveState) -> Self {
        TrayView { icon: live.state, tooltip: tooltip_for(live.phase, live.viewers), can_start: live.can_start, can_stop: live.can_stop }
    }
}

/// Tooltip for a live phase (mirrors trayStateFor() in apps/server/src/tray/tray.ts).
pub fn tooltip_for(phase: Phase, viewers: u64) -> String {
    match phase {
        Phase::Off => t("tooltip.off"),
        Phase::Starting => t("tooltip.starting"),
        Phase::WaitingObs => t("tooltip.waiting"),
        Phase::Stopping => t("tooltip.stopping"),
        Phase::Live if viewers == 1 => t("tooltip.live_one"),
        Phase::Live => tr("tooltip.live_many", &[("n", &viewers.to_string())]),
    }
}

struct Handles {
    tray: TrayIcon,
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    last: Option<TrayView>,
}

/// Managed state: the tray, if it could be created (Linux needs an AppIndicator host).
pub struct TrayState(Mutex<Option<Handles>>);

fn icon_bytes(state: IconState) -> &'static [u8] {
    match state {
        IconState::Off => ICON_OFF,
        IconState::Waiting => ICON_WAITING,
        IconState::Live => ICON_LIVE,
    }
}

pub fn create(app: &AppHandle, shell: Arc<Shell>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", t("tray.open"), true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", t("tray.start"), false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", t("tray.stop"), false, None::<&str>)?;
    let check = MenuItem::with_id(app, "check-updates", t("tray.check_updates"), true, None::<&str>)?;
    let export = MenuItem::with_id(app, "export-logs", t("tray.export_logs"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t("tray.quit"), true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &PredefinedMenuItem::separator(app)?, &start, &stop, &PredefinedMenuItem::separator(app)?, &check, &export, &quit],
    )?;
    let view = TrayView::starting();
    let menu_shell = shell.clone();
    let tray = TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(icon_bytes(view.icon))?)
        .tooltip(&view.tooltip)
        .menu(&menu)
        // Windows / Linux convention: left click opens the window, right click the menu.
        // macOS: the menu opens on click, like every menu bar item.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(move |_app, event| {
            let shell = menu_shell.clone();
            match event.id.as_ref() {
                "open" => shell.show_window(),
                "start" => shell.click(ClickId::Start),
                "stop" => shell.click(ClickId::Stop),
                "check-updates" => updater::check_soon(shell, true),
                "export-logs" => shell.export_logs(),
                "quit" => shell.request_quit(false),
                _ => {}
            }
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if !cfg!(target_os = "macos") {
                    shell.show_window();
                }
            }
        })
        .build(app)?;
    app.manage(TrayState(Mutex::new(Some(Handles { tray, start, stop, last: Some(view) }))));
    Ok(())
}

/// Applies `view` (only what changed).
pub fn update(app: &AppHandle, view: &TrayView) {
    let Some(state) = app.try_state::<TrayState>() else { return };
    let mut guard = state.0.lock().unwrap();
    let Some(h) = guard.as_mut() else { return };
    if h.last.as_ref() == Some(view) {
        return;
    }
    if h.last.as_ref().map(|l| l.icon) != Some(view.icon) {
        match Image::from_bytes(icon_bytes(view.icon)) {
            Ok(img) => {
                let _ = h.tray.set_icon(Some(img));
            }
            Err(err) => logs::shell(format!("tray icon: {err}")),
        }
    }
    let _ = h.tray.set_tooltip(Some(&view.tooltip));
    let _ = h.start.set_enabled(view.can_start);
    let _ = h.stop.set_enabled(view.can_stop);
    h.last = Some(view.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{tr_in, Lang};

    #[test]
    fn tooltips_follow_the_phase() {
        // The test runs in whatever the machine language is: compare with that language.
        let lang = crate::i18n::lang();
        assert_eq!(tooltip_for(Phase::Live, 1), tr_in(lang, "tooltip.live_one", &[]));
        assert_eq!(tooltip_for(Phase::Live, 7), tr_in(lang, "tooltip.live_many", &[("n", "7")]));
        assert_eq!(tooltip_for(Phase::WaitingObs, 0), tr_in(lang, "tooltip.waiting", &[]));
        assert_eq!(tr_in(Lang::En, "tooltip.live_many", &[("n", "7")]), "SwarmCast: live · 7 viewers");
    }

    #[test]
    fn view_from_live_state() {
        let live =
            LiveState { state: IconState::Live, phase: Phase::Live, viewers: 2, can_start: false, can_stop: true, tooltip: String::new() };
        let view = TrayView::from_live(&live);
        assert_eq!(view.icon, IconState::Live);
        assert!(view.can_stop && !view.can_start);
        let starting = TrayView::starting();
        assert!(!starting.can_start && !starting.can_stop);
    }
}
