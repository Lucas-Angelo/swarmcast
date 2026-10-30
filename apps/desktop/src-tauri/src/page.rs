//! Which page the main window shows, known without asking the webview.
//!
//! The shell never calls `WebviewWindow::url()`: on macOS it panics while WKWebView has no URL
//! (wry 0.57 `url_from_webview` unwraps `WKWebView.URL`, which is nil until a navigation
//! commits), and since any panic ends the app (main.rs, `abort_on_panic`) the whole app died when "Update now" arrived while the
//! panel was still loading. Instead the page follows the shell's own navigations and the
//! webview's page-load events.

use std::time::{Duration, Instant};

use url::Url;

use crate::window;

/// A splash load that has not reported back in this time is started again.
pub const SPLASH_LOAD_TIMEOUT: Duration = Duration::from_secs(5);

/// The local splash page, the admin panel, or something else (`about:blank`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Splash,
    Panel,
    Other,
}

impl Page {
    pub fn of(url: &Url) -> Page {
        if window::is_local(url) {
            Page::Splash
        } else if matches!(url.scheme(), "http" | "https") {
            Page::Panel
        } else {
            Page::Other
        }
    }
}

/// How a new splash status gets onto the splash page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplashRoute {
    /// The splash is shown: update it in place.
    Update,
    /// The splash is loading: it asks for the status when its script runs, and the shell
    /// pushes the latest one again when the load finishes.
    Wait,
    /// Another page is shown or loading: navigate to the splash.
    Navigate,
}

#[derive(Debug)]
pub struct PageTracker {
    shown: Page,
    /// A navigation the shell started whose page has not loaded yet, and since when.
    pending: Option<(Page, Instant)>,
}

impl PageTracker {
    /// The window is built with the splash, which is loading.
    pub fn new(now: Instant) -> Self {
        PageTracker { shown: Page::Other, pending: Some((Page::Splash, now)) }
    }

    /// The shell asked the webview to open `page`.
    pub fn navigating(&mut self, page: Page, now: Instant) {
        self.pending = Some((page, now));
    }

    /// A page load started (committed) or finished. While a navigation is pending, events of
    /// other pages (the page being left) are ignored. Returns whether `page` is now shown.
    pub fn loaded(&mut self, page: Page) -> bool {
        if self.pending.is_some_and(|(p, _)| p != page) {
            return false;
        }
        self.pending = None;
        self.shown = page;
        true
    }

    pub fn splash_route(&self, now: Instant) -> SplashRoute {
        match (self.pending, self.shown) {
            (Some((Page::Splash, since)), _) if now.saturating_duration_since(since) < SPLASH_LOAD_TIMEOUT => SplashRoute::Wait,
            (None, Page::Splash) => SplashRoute::Update,
            _ => SplashRoute::Navigate,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn pages_by_url() {
        assert_eq!(Page::of(&u("tauri://localhost/index.html")), Page::Splash);
        assert_eq!(Page::of(&u("http://tauri.localhost/index.html")), Page::Splash);
        assert_eq!(Page::of(&window::splash_url()), Page::Splash);
        assert_eq!(Page::of(&u("http://127.0.0.1:8081/auth/abc")), Page::Panel);
        assert_eq!(Page::of(&u("about:blank")), Page::Other);
    }

    /// The window was just built and the webview has no URL yet (where wry's `url()` panics on
    /// macOS): the shell knows the splash is loading without asking the webview.
    #[test]
    fn a_new_window_waits_for_its_splash_without_a_url() {
        let t0 = Instant::now();
        let mut page = PageTracker::new(t0);
        assert_eq!(page.splash_route(t0), SplashRoute::Wait);
        assert!(page.loaded(Page::Splash));
        assert_eq!(page.splash_route(t0), SplashRoute::Update);
    }

    /// "Update now" right after `ready`: the panel is still loading, so the shell goes back to
    /// the splash, and late events of the page being left change nothing.
    #[test]
    fn an_update_while_the_panel_loads_goes_back_to_the_splash() {
        let t0 = Instant::now();
        let mut page = PageTracker::new(t0);
        page.navigating(Page::Panel, t0);
        assert!(!page.loaded(Page::Splash), "late event of the splash being left");
        assert_eq!(page.splash_route(t0), SplashRoute::Navigate);
        page.navigating(Page::Splash, t0);
        assert!(!page.loaded(Page::Panel), "late event of the panel being left");
        assert_eq!(page.splash_route(t0), SplashRoute::Wait);
        assert!(page.loaded(Page::Splash));
        assert_eq!(page.splash_route(t0), SplashRoute::Update);
    }

    #[test]
    fn the_panel_and_its_own_navigations_are_not_the_splash() {
        let t0 = Instant::now();
        let mut page = PageTracker::new(t0);
        assert!(page.loaded(Page::Splash));
        page.navigating(Page::Panel, t0);
        assert!(page.loaded(Page::Panel));
        // The panel's /auth page opens / by itself; a reload (Cmd+R) loads it again.
        assert!(page.loaded(Page::Panel));
        assert_eq!(page.splash_route(t0), SplashRoute::Navigate);
    }

    #[test]
    fn a_splash_load_that_never_reports_is_started_again() {
        let t0 = Instant::now();
        let mut page = PageTracker::new(t0);
        page.navigating(Page::Splash, t0);
        assert_eq!(page.splash_route(t0 + SPLASH_LOAD_TIMEOUT - Duration::from_millis(1)), SplashRoute::Wait);
        assert_eq!(page.splash_route(t0 + SPLASH_LOAD_TIMEOUT), SplashRoute::Navigate);
    }

    /// A panel navigation that never commits (the server died) leaves the splash document in
    /// place, but the shell cannot be sure of that: it navigates to the splash again.
    #[test]
    fn a_panel_navigation_that_never_loads_falls_back_to_navigating() {
        let t0 = Instant::now();
        let mut page = PageTracker::new(t0);
        assert!(page.loaded(Page::Splash));
        page.navigating(Page::Panel, t0);
        assert_eq!(page.splash_route(t0 + Duration::from_secs(60)), SplashRoute::Navigate);
    }
}
