//! The app window: the local splash page, then the admin panel served by the server.
//!
//! Only the splash (local origin) has IPC access (capabilities/main.json has no `remote`
//! entry): the panel talks to the server over HTTP, and the server forwards what the shell
//! needs over stdio. Anything that is neither the splash nor the admin origin opens in the
//! default browser.

use std::sync::{Arc, RwLock};

use tauri::webview::NewWindowResponse;
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
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
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
        });
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&webview2_args(crate::i18n::locale()));
    let window = builder.build()?;
    if let Ok(url) = window.url() {
        shell.set_splash_url(url);
    }
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

    #[test]
    fn splash_is_local() {
        assert!(is_local(&u("tauri://localhost/index.html")));
        assert!(is_local(&u("http://tauri.localhost/index.html")));
        assert!(!is_local(&u("http://localhost/")));
        assert!(!is_local(&u("https://tauri.localhost.evil.com/")));
    }

    #[test]
    fn only_the_admin_origin_stays_in_the_window() {
        let admin = u("http://127.0.0.1:8081/auth/x").origin();
        assert_eq!(navigation_policy(&u("http://127.0.0.1:8081/"), Some(&admin)), Nav::Allow);
        assert_eq!(navigation_policy(&u("http://127.0.0.1:8080/watch"), Some(&admin)), Nav::External);
        assert_eq!(navigation_policy(&u("http://localhost:8081/"), Some(&admin)), Nav::External);
        assert_eq!(navigation_policy(&u("https://obsproject.com/forum/"), Some(&admin)), Nav::External);
        assert_eq!(navigation_policy(&u("http://127.0.0.1:8081/"), None), Nav::External);
        assert_eq!(navigation_policy(&u("tauri://localhost/index.html"), Some(&admin)), Nav::Allow);
        assert_eq!(navigation_policy(&u("mailto:a@b.c"), Some(&admin)), Nav::External);
        assert_eq!(navigation_policy(&u("file:///etc/passwd"), Some(&admin)), Nav::Block);
        assert_eq!(navigation_policy(&u("javascript:alert(1)"), Some(&admin)), Nav::Block);
    }

    #[test]
    fn webview2_args_keep_wry_defaults() {
        assert_eq!(webview2_args("pt-BR"), "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --lang=pt-BR");
        assert_eq!(webview2_args("pt-BR --evil"), "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --lang=pt-BR--evil");
    }
}
