//! The app window: the local splash page, then the admin panel served by the server.
//!
//! Only the splash (local origin) has IPC access (capabilities/main.json has no `remote`
//! entry): the panel talks to the server over HTTP, and the server forwards what the shell
//! needs over stdio. Anything that is neither the splash nor the admin origin opens in the
//! default browser.

use std::sync::{Arc, RwLock};

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{App, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::shell::{self, Shell, MAIN_WINDOW};

/// What to do with a navigation of the main webview.
#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    Allow,
    /// Cancel it and open the URL in the default browser.
    External,
    Block,
}

/// The splash is served by Tauri itself: `tauri://localhost` (macOS, Linux) or
/// `http(s)://tauri.localhost` (Windows).
pub fn is_local(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// The splash page, relative to the app's frontend (`build.frontendDist`).
const SPLASH_PAGE: &str = "index.html";

/// Where Tauri serves `WebviewUrl::App(SPLASH_PAGE)` (no `devUrl`, no `useHttpsScheme`). Known
/// up front: the webview's own `url()` panics on macOS before the first page commits.
pub fn splash_url() -> Url {
    let origin = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(origin).and_then(|o| o.join(SPLASH_PAGE)).expect("the splash URL is a valid constant")
}

pub fn navigation_policy(url: &Url, admin: Option<&url::Origin>) -> Nav {
    if is_local(url) || matches!(url.as_str(), "about:blank" | "about:srcdoc") {
        return Nav::Allow;
    }
    match url.scheme() {
        "http" | "https" => {
            if admin.is_some_and(|origin| *origin == url.origin()) {
                Nav::Allow
            } else {
                Nav::External
            }
        }
        "mailto" => Nav::External,
        _ => Nav::Block,
    }
}

/// WebView2 language (Windows): `navigator.language` follows the OS like in a browser.
/// These args replace wry's defaults, so they are repeated here.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn webview2_args(locale: &str) -> String {
    let safe: String = locale.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --lang={safe}")
}

/// Injected in every page: a `target=_blank` link to another origin becomes a normal
/// navigation, which `on_navigation` turns into "open in the browser" (the panel stays).
/// Without it, WebKit may drop such clicks when it decides they are unrequested pop-ups.
const LINKS_SCRIPT: &str = r#"
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[href][target]') : null;
  if (!a || e.defaultPrevented || a.target === '_self' || a.target === '_top' || a.target === '_parent') return;
  let url;
  try { url = new URL(a.href, location.href); } catch { return; }
  if (url.origin === location.origin || !/^(https?|mailto):$/.test(url.protocol)) return;
  e.preventDefault();
  location.assign(url.href);
}, true);
"#;

pub fn create(app: &App, shell: &Arc<Shell>, visible: bool) -> tauri::Result<()> {
    let handle = app.handle().clone();
    let origin: Arc<RwLock<Option<url::Origin>>> = shell.admin_origin();
    let nav_handle = handle.clone();
    let popup_handle = handle.clone();
    let page_shell = shell.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App(SPLASH_PAGE.into()))
        .title("SwarmCast")
        .inner_size(1200.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .visible(visible)
        .initialization_script(LINKS_SCRIPT)
        .on_navigation(move |url| {
            let admin = origin.read().unwrap();
            match navigation_policy(url, admin.as_ref()) {
                Nav::Allow => true,
                Nav::External => {
                    shell::open_external(&nav_handle, url);
                    false
                }
                Nav::Block => {
                    crate::logs::shell(format!("blocked navigation to {url}"));
                    false
                }
            }
        })
        // window.open / target=_blank: never a second webview, always the default browser.
        .on_new_window(move |url, _features| {
            if !is_local(&url) {
                shell::open_external(&popup_handle, &url);
            }
            NewWindowResponse::Deny
        })
        // The shell follows the page from these events instead of asking the webview (page.rs).
        .on_page_load(move |_window, payload| {
            page_shell.on_page_load(payload.url(), matches!(payload.event(), PageLoadEvent::Finished));
        });
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&webview2_args(crate::i18n::locale()));
    let window = builder.build()?;
    let close_shell = shell.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            close_shell.request_quit(true);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    /// Tauri's own origins only: plain localhost or a look-alike host is not the splash.
    #[test]
    fn splash_is_local() {
        // Arrange
        let urls = [
            u("tauri://localhost/index.html"),
            u("http://tauri.localhost/index.html"),
            u("http://localhost/"),
            u("https://tauri.localhost.evil.com/"),
        ];

        // Act
        let local = urls.map(|url| is_local(&url));

        // Assert
        assert_eq!(local, [true, true, false, false]);
    }

    #[test]
    fn splash_url_is_the_local_index_page() {
        // Act
        let url = splash_url();

        // Assert
        assert!(is_local(&url), "{url}");
        assert_eq!(url.path(), "/index.html");
    }

    /// The admin origin (scheme, host and port) and the splash stay; other http(s) and mailto
    /// links open in the browser, other schemes are blocked. Before `ready` there is no admin
    /// origin: the panel's address opens in the browser too.
    #[test]
    fn only_the_admin_origin_stays_in_the_window() {
        // Arrange
        let admin = u("http://127.0.0.1:8081/auth/x").origin();
        let cases = [
            ("http://127.0.0.1:8081/", Nav::Allow),
            ("http://127.0.0.1:8080/watch", Nav::External),
            ("http://localhost:8081/", Nav::External),
            ("https://obsproject.com/forum/", Nav::External),
            ("tauri://localhost/index.html", Nav::Allow),
            ("mailto:a@b.c", Nav::External),
            ("file:///etc/passwd", Nav::Block),
            ("javascript:alert(1)", Nav::Block),
        ];

        // Act
        let decided: Vec<(&str, Nav)> = cases.iter().map(|(url, _)| (*url, navigation_policy(&u(url), Some(&admin)))).collect();
        let before_ready = navigation_policy(&u("http://127.0.0.1:8081/"), None);

        // Assert
        assert_eq!(decided, cases.into_iter().collect::<Vec<_>>());
        assert_eq!(before_ready, Nav::External);
    }

    #[test]
    fn webview2_args_keep_wry_defaults() {
        // Act
        let args = webview2_args("pt-BR");

        // Assert
        assert_eq!(args, "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --lang=pt-BR");
    }

    /// The locale comes from the OS or SWARMCAST_LOCALE: anything but letters, digits and "-" is
    /// dropped, so it cannot add a browser argument of its own.
    #[test]
    fn a_locale_cannot_add_webview2_args() {
        // Act
        let args = webview2_args("pt-BR --evil");

        // Assert
        assert_eq!(args, "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --lang=pt-BR--evil");
    }
}
