//! SwarmCast desktop shell: an app window, a tray icon and auto-update around the
//! SwarmCast server (`swarmcast-server --desktop`, a sidecar). Design and contract with the
//! server: docs/DESKTOP.md.

// Release builds on Windows: no console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod i18n;
mod logs;
mod page;
mod protocol;
mod shell;
mod sidecar;
mod tray;
mod updater;
mod window;

use std::sync::Arc;

use tauri::{Manager, RunEvent};

use shell::Shell;

// wry relies on catching Objective-C exceptions that WebKit throws for custom-protocol requests
// the page already dropped (Cargo.toml, [profile.release]); with panic = "abort" it cannot, and
// the app crashes with "This task has already been stopped".
#[cfg(all(target_vendor = "apple", panic = "abort"))]
compile_error!("the desktop app must be built with panic = \"unwind\" on macOS: see [profile.release] in Cargo.toml");

/// Any Rust panic still ends the app at once, as `panic = "abort"` did: a panicking thread
/// must not leave a half-working app behind. The binary unwinds only so that Objective-C
/// exceptions can be caught where wry expects them (they are not panics and skip this hook).
fn abort_on_panic() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default(info);
        std::process::abort();
    }));
}

/// SIGTERM / SIGINT / SIGHUP (logout, `kill`, Ctrl+C in a terminal): quit cleanly, without
/// asking, so the server stops the live and its children instead of being orphaned.
#[cfg(unix)]
fn quit_on_signals(shell: Arc<Shell>) {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    match signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) {
        Ok(mut signals) => {
            std::thread::spawn(move || {
                for sig in signals.forever() {
                    logs::shell(format!("received signal {sig}, quitting"));
                    shell.quit();
                }
            });
        }
        Err(err) => logs::shell(format!("cannot handle signals: {err}")),
    }
}

/// macOS app menu, localized (the default one is English only). Quit goes through the same
/// path as the tray (asks when the live is on).
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use i18n::t;
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let about =
        AboutMetadata { name: Some("SwarmCast".into()), version: Some(app.package_info().version.to_string()), ..Default::default() };
    let app_menu = Submenu::with_items(
        app,
        "SwarmCast",
        true,
        &[
            &P::about(app, Some(&t("menu.about")), Some(about))?,
            &P::separator(app)?,
            &P::hide(app, Some(&t("menu.hide")))?,
            &P::hide_others(app, Some(&t("menu.hide_others")))?,
            &P::show_all(app, Some(&t("menu.show_all")))?,
            &P::separator(app)?,
            &MenuItem::with_id(app, "app-quit", t("menu.quit"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        t("menu.edit"),
        true,
        &[
            &P::undo(app, Some(&t("menu.undo")))?,
            &P::redo(app, Some(&t("menu.redo")))?,
            &P::separator(app)?,
            &P::cut(app, Some(&t("menu.cut")))?,
            &P::copy(app, Some(&t("menu.copy")))?,
            &P::paste(app, Some(&t("menu.paste")))?,
            &P::select_all(app, Some(&t("menu.select_all")))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        t("menu.view"),
        true,
        &[&MenuItem::with_id(app, "app-reload", t("menu.reload"), true, Some("CmdOrCtrl+R"))?],
    )?;
    let window = Submenu::with_items(
        app,
        t("menu.window"),
        true,
        &[
            &P::minimize(app, Some(&t("menu.minimize")))?,
            &P::maximize(app, Some(&t("menu.zoom")))?,
            &P::separator(app)?,
            &P::close_window(app, Some(&t("menu.close")))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

fn main() {
    abort_on_panic();
    // Autostart entries start the app with --background: tray only, no window.
    let background = std::env::args().any(|a| a == "--background");

    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            logs::shell(format!("second launch ({}), showing the window", args.join(" ")));
            if let Some(shell) = app.try_state::<Arc<Shell>>() {
                shell.show_window();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![shell::splash_status, shell::splash_retry, shell::splash_open_logs])
        .setup(move |app| {
            // Right after an update the window shows even if the app had been started with
            // --background (the relaunch keeps the original arguments).
            let relaunched = updater::take_relaunch_marker();
            let visible = !background || relaunched;
            // A login start keeps the live off (no public tunnel at every boot), also after
            // an update relaunched it.
            let shell = Shell::new(app.handle(), background)?;
            app.manage(shell.clone());
            #[cfg(target_os = "macos")]
            if !visible {
                app.set_dock_visibility(false);
            }
            #[cfg(target_os = "macos")]
            {
                app.set_menu(app_menu(app.handle())?)?;
                let menu_shell = shell.clone();
                app.on_menu_event(move |_app, event| match event.id.as_ref() {
                    "app-quit" => menu_shell.request_quit(false),
                    "app-reload" => {
                        if let Some(window) = menu_shell.window() {
                            let _ = window.reload();
                        }
                    }
                    _ => {}
                });
            }
            window::create(app, &shell, visible)?;
            match tray::create(app.handle(), shell.clone()) {
                Ok(()) => shell.set_has_tray(true),
                // e.g. a Linux desktop without an AppIndicator host: window only.
                Err(err) => logs::shell(format!("no tray icon: {err}")),
            }
            #[cfg(unix)]
            quit_on_signals(shell.clone());
            shell.start();
            updater::schedule(shell);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the SwarmCast app");

    app.run(|app, event| match event {
        // Cmd+Q, the Dock's Quit, logout…: same as the tray's Quit (asks when the live is on).
        // `app.exit()` from our own quit carries a code and goes through.
        RunEvent::ExitRequested { code: None, api, .. } => {
            api.prevent_exit();
            if let Some(shell) = app.try_state::<Arc<Shell>>() {
                shell.inner().clone().request_quit(false);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(shell) = app.try_state::<Arc<Shell>>() {
                shell.show_window();
            }
        }
        _ => {}
    });
}
