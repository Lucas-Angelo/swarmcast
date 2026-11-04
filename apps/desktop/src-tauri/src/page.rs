//! Which page the main window shows, known without asking the webview.
//!
//! The shell never calls `WebviewWindow::url()`: on macOS it panics while WKWebView has no URL
//! (wry 0.57 `url_from_webview` unwraps `WKWebView.URL`, which is nil until a navigation
//! commits), and since any panic ends the app (main.rs, `abort_on_panic`) the whole app died when "Update now" arrived while the
//! panel was still loading. Instead the page follows the shell's own navigations and the
//! webview's page-load events.
//!
//! It also watches every navigation the shell starts (the watchdog): one that has not committed
//! in time is started again (`COMMIT_TIMEOUTS`). WebKit can lose a navigation for good when its
//! answer moves the page to a new web process, as the panel's `Cross-Origin-Opener-Policy:
//! same-origin` does for the splash → panel navigation of a new window: the load then never
//! commits, and without the watchdog the window stayed on the splash (WebKitGTK 2.52: 18 app starts
//! in 12,000; docs/DESKTOP.md, "Panel load watchdog").

use std::time::{Duration, Instant};

use url::Url;

use crate::window;

/// A splash load that has not reported back in this time is started again.
pub const SPLASH_LOAD_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a navigation the shell started gets to commit before the shell starts it again: the
/// first wait, the second, ..., and the last one again for every attempt after that. A lost
/// navigation never commits, so the first wait only has to be longer than a real load on a busy
/// computer (a page from 127.0.0.1 commits in well under a second: 1.8 s at most in the Docker
/// harness with 12 loops sharing the CPU, 5.4 s on a Mac short of memory); the longer waits after
/// it make sure that a computer too slow for 5 s still gets the page. There is no last attempt:
/// the shell only opens the splash or, after `ready`, the panel, and opening it once more costs
/// one local request.
pub const COMMIT_TIMEOUTS: [Duration; 4] =
    [Duration::from_secs(5), Duration::from_secs(10), Duration::from_secs(20), Duration::from_secs(30)];

/// The wait of attempt `attempt` of a navigation (0: the shell's own, 1: the first watchdog one…).
pub fn commit_timeout(attempt: u32) -> Duration {
    let last = COMMIT_TIMEOUTS.len() - 1;
    COMMIT_TIMEOUTS[usize::try_from(attempt).map_or(last, |a| a.min(last))]
}

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

/// A navigation the shell started whose page has not committed yet.
#[derive(Clone, Copy, Debug)]
struct Pending {
    page: Page,
    /// When its current attempt started.
    since: Instant,
    /// Tells this navigation from the ones before and after it (a watch of an older one is stale).
    id: u64,
    /// 0 for the shell's own navigation, then one more each time the watchdog starts it again.
    attempt: u32,
}

/// The watchdog's next look at a navigation: `after` from now, call `PageTracker::overdue(id, …)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Watch {
    pub id: u64,
    pub after: Duration,
}

/// A navigation that did not commit in time: the shell opens `page` again (attempt `attempt`),
/// then looks at it again with `watch`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Renavigate {
    pub page: Page,
    pub attempt: u32,
    /// How long the attempt that did not commit waited.
    pub waited: Duration,
    pub watch: Watch,
}

#[derive(Debug)]
pub struct PageTracker {
    shown: Page,
    pending: Option<Pending>,
    next_id: u64,
}

impl PageTracker {
    /// The window is built with the splash, which is loading (watched with `first_watch`).
    pub fn new(now: Instant) -> Self {
        PageTracker { shown: Page::Other, pending: Some(Pending { page: Page::Splash, since: now, id: 0, attempt: 0 }), next_id: 1 }
    }

    /// The watchdog's first look at the page the window is built with.
    pub fn first_watch(&self) -> Watch {
        Watch { id: 0, after: commit_timeout(0) }
    }

    /// The shell asked the webview to open `page`. Returns the watchdog's first look at it.
    pub fn navigating(&mut self, page: Page, now: Instant) -> Watch {
        let id = self.next_id;
        self.next_id += 1;
        self.pending = Some(Pending { page, since: now, id, attempt: 0 });
        Watch { id, after: commit_timeout(0) }
    }

    /// A page committed (the webview's "started" event: wry sends it on commit on every OS).
    /// While a navigation is pending, commits of other pages (the page being left) are ignored.
    /// Returns whether `page` is now shown.
    pub fn committed(&mut self, page: Page) -> bool {
        if self.pending.is_some_and(|p| p.page != page) {
            return false;
        }
        self.pending = None;
        self.shown = page;
        true
    }

    /// A page finished loading: whether it is the page shown, with no navigation pending. A
    /// finish never ends a pending navigation by itself: WebKitGTK sends one, with the panel's
    /// URL, for the very navigation it lost (and after any load that failed), none of which
    /// committed; the watchdog then opens the page again.
    pub fn finished(&self, page: Page) -> bool {
        self.pending.is_none() && self.shown == page
    }

    /// The watchdog's look at navigation `id`, `Watch::after` after it (re)started. `None` when
    /// it committed meanwhile or the shell started another navigation since (nothing to do);
    /// otherwise the attempt is counted and the shell must open the page again.
    pub fn overdue(&mut self, id: u64, now: Instant) -> Option<Renavigate> {
        let pending = self.pending.as_mut().filter(|p| p.id == id)?;
        let waited = now.saturating_duration_since(pending.since);
        pending.attempt = pending.attempt.saturating_add(1);
        pending.since = now;
        Some(Renavigate {
            page: pending.page,
            attempt: pending.attempt,
            waited,
            watch: Watch { id, after: commit_timeout(pending.attempt) },
        })
    }

    pub fn splash_route(&self, now: Instant) -> SplashRoute {
        match (self.pending, self.shown) {
            (Some(Pending { page: Page::Splash, since, .. }), _) if now.saturating_duration_since(since) < SPLASH_LOAD_TIMEOUT => {
                SplashRoute::Wait
            }
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

    /// A tracker whose splash has loaded (the state after the first page load).
    fn on_the_splash(t0: Instant) -> PageTracker {
        let mut page = PageTracker::new(t0);
        assert!(page.committed(Page::Splash), "the first splash load");
        page
    }

    /// The splash is served by Tauri on `tauri://localhost` (macOS, Linux) or `http://tauri.localhost`
    /// (Windows); the panel is the server's http origin.
    #[test]
    fn pages_by_url() {
        // Arrange
        let urls = [
            u("tauri://localhost/index.html"),
            u("http://tauri.localhost/index.html"),
            window::splash_url(),
            u("http://127.0.0.1:8081/auth/abc"),
            u("about:blank"),
        ];

        // Act
        let pages = urls.map(|url| Page::of(&url));

        // Assert
        assert_eq!(pages, [Page::Splash, Page::Splash, Page::Splash, Page::Panel, Page::Other]);
    }

    /// The window was just built and the webview has no URL yet (where wry's `url()` panics on
    /// macOS): the shell knows the splash is loading without asking the webview.
    #[test]
    fn a_new_window_waits_for_its_splash_without_a_url() {
        // Arrange
        let t0 = Instant::now();
        let mut page = PageTracker::new(t0);

        // Act
        let while_loading = page.splash_route(t0);
        let shown = page.committed(Page::Splash);

        // Assert
        assert_eq!(while_loading, SplashRoute::Wait);
        assert!(shown);
        assert_eq!(page.splash_route(t0), SplashRoute::Update);
    }

    /// "Update now" right after `ready`: the panel is still loading, so the shell goes back to
    /// the splash, and late events of the page being left change nothing.
    #[test]
    fn an_update_while_the_panel_loads_goes_back_to_the_splash() {
        // Arrange
        let t0 = Instant::now();
        let mut page = PageTracker::new(t0);

        // Act
        page.navigating(Page::Panel, t0);
        let late_splash_event = page.committed(Page::Splash);

        // Assert
        assert!(!late_splash_event, "late event of the splash being left");
        assert_eq!(page.splash_route(t0), SplashRoute::Navigate);

        // Act
        page.navigating(Page::Splash, t0);
        let late_panel_event = page.committed(Page::Panel);

        // Assert
        assert!(!late_panel_event, "late event of the panel being left");
        assert_eq!(page.splash_route(t0), SplashRoute::Wait);

        // Act
        let shown = page.committed(Page::Splash);

        // Assert
        assert!(shown);
        assert_eq!(page.splash_route(t0), SplashRoute::Update);
    }

    /// The panel's /auth page opens / by itself, and a reload (Cmd+R) loads it again: more loads
    /// of the panel than navigations of the shell, none of them the splash.
    #[test]
    fn the_panel_and_its_own_navigations_are_not_the_splash() {
        // Arrange
        let t0 = Instant::now();
        let mut page = on_the_splash(t0);
        page.navigating(Page::Panel, t0);

        // Act
        let loads = [page.committed(Page::Panel), page.committed(Page::Panel)];

        // Assert
        assert_eq!(loads, [true, true]);
        assert_eq!(page.splash_route(t0), SplashRoute::Navigate);
    }

    #[test]
    fn a_splash_load_that_never_reports_is_started_again() {
        // Arrange
        let t0 = Instant::now();
        let mut page = PageTracker::new(t0);

        // Act
        page.navigating(Page::Splash, t0);

        // Assert
        assert_eq!(page.splash_route(t0 + SPLASH_LOAD_TIMEOUT - Duration::from_millis(1)), SplashRoute::Wait);
        assert_eq!(page.splash_route(t0 + SPLASH_LOAD_TIMEOUT), SplashRoute::Navigate);
    }

    /// A panel navigation that never commits (the server died) leaves the splash document in
    /// place, but the shell cannot be sure of that: it navigates to the splash again.
    #[test]
    fn a_panel_navigation_that_never_loads_falls_back_to_navigating() {
        // Arrange
        let t0 = Instant::now();
        let mut page = on_the_splash(t0);

        // Act
        page.navigating(Page::Panel, t0);

        // Assert
        assert_eq!(page.splash_route(t0 + Duration::from_secs(60)), SplashRoute::Navigate);
    }

    fn s(secs: u64) -> Duration {
        Duration::from_secs(secs)
    }

    /// WebKit's COOP race (docs/DESKTOP.md, "Panel load watchdog"): the splash → panel
    /// navigation never commits and never fails. The watchdog opens the panel again after 5 s,
    /// then waits longer each time (10 s, 20 s, then every 30 s) until it commits, and then stops.
    #[test]
    fn a_lost_panel_navigation_is_opened_again_until_it_commits() {
        // Arrange
        let t0 = Instant::now();
        let mut page = on_the_splash(t0);
        let first = page.navigating(Page::Panel, t0);

        // Act
        let mut at = t0;
        let mut watch = first;
        let mut again = Vec::new();
        for _ in 0..5 {
            at += watch.after;
            let r = page.overdue(watch.id, at).expect("the panel has not committed: open it again");
            watch = r.watch;
            again.push((r.page, r.attempt, r.waited.as_secs(), r.watch.after.as_secs()));
        }
        let shown = page.committed(Page::Panel);
        let after_commit = page.overdue(watch.id, at + watch.after);

        // Assert
        assert_eq!(first.after, s(5));
        assert_eq!(
            again,
            [
                (Page::Panel, 1, 5, 10),
                (Page::Panel, 2, 10, 20),
                (Page::Panel, 3, 20, 30),
                (Page::Panel, 4, 30, 30),
                (Page::Panel, 5, 30, 30)
            ]
        );
        assert!(shown);
        assert_eq!(after_commit, None, "a committed panel is left alone");
        assert!(page.finished(Page::Panel));
    }

    /// The usual case: the panel commits well before its first look, which then changes nothing.
    #[test]
    fn a_panel_that_commits_in_time_is_left_alone() {
        // Arrange
        let t0 = Instant::now();
        let mut page = on_the_splash(t0);
        let watch = page.navigating(Page::Panel, t0);

        // Act
        let shown = page.committed(Page::Panel);
        let look = page.overdue(watch.id, t0 + watch.after);

        // Assert
        assert!(shown);
        assert_eq!(look, None);
    }

    /// While the panel's navigation is lost, the page being left (the splash) can still report;
    /// that is not the panel committing, so the watchdog still opens the panel again.
    #[test]
    fn events_of_the_page_being_left_do_not_end_the_watch() {
        // Arrange
        let t0 = Instant::now();
        let mut page = on_the_splash(t0);
        let watch = page.navigating(Page::Panel, t0);

        // Act
        let late_splash_commit = page.committed(Page::Splash);
        let late_splash_finish = page.finished(Page::Splash);
        let look = page.overdue(watch.id, t0 + watch.after);

        // Assert
        assert!(!late_splash_commit && !late_splash_finish);
        assert_eq!(look.map(|r| (r.page, r.attempt)), Some((Page::Panel, 1)));
    }

    /// What WebKitGTK reports for the navigation it loses (measured, docs/DESKTOP.md): "finished"
    /// with the panel's URL, and never a commit. Only a commit ends the watch, so the lost panel
    /// is opened again (so is a load that failed, which reports the same).
    #[test]
    fn a_finish_without_a_commit_does_not_end_the_watch() {
        // Arrange
        let t0 = Instant::now();
        let mut page = on_the_splash(t0);
        let watch = page.navigating(Page::Panel, t0);

        // Act
        let finished = page.finished(Page::Panel);
        let look = page.overdue(watch.id, t0 + watch.after);

        // Assert
        assert!(!finished);
        assert_eq!(look.map(|r| r.page), Some(Page::Panel));
    }

    /// A newer navigation replaces the one being watched (the server crashed or an update
    /// started while the panel loaded): the old watch finds nothing to do, the new one is watched.
    #[test]
    fn a_newer_navigation_makes_the_old_watch_stale() {
        // Arrange
        let t0 = Instant::now();
        let mut page = on_the_splash(t0);
        let panel = page.navigating(Page::Panel, t0);
        let splash = page.navigating(Page::Splash, t0 + s(1));

        // Act
        let old = page.overdue(panel.id, t0 + panel.after);
        let new = page.overdue(splash.id, t0 + s(1) + splash.after);

        // Assert
        assert_ne!(panel.id, splash.id);
        assert_eq!(old, None);
        assert_eq!(new.map(|r| (r.page, r.attempt)), Some((Page::Splash, 1)));
    }

    /// The splash the window is built with is watched too, from the start.
    #[test]
    fn the_first_splash_is_watched() {
        // Arrange
        let t0 = Instant::now();
        let mut page = PageTracker::new(t0);
        let watch = page.first_watch();

        // Act
        let lost = page.overdue(watch.id, t0 + watch.after);
        let shown = page.committed(Page::Splash);
        let after_commit = page.overdue(watch.id, t0 + s(60));

        // Assert
        assert_eq!(watch.after, s(5));
        assert_eq!(lost.map(|r| r.page), Some(Page::Splash));
        assert!(shown);
        assert_eq!(after_commit, None);
    }

    /// A watchdog attempt restarts the splash's own wait, so a splash status shown meanwhile
    /// waits for the load the watchdog started instead of navigating once more.
    #[test]
    fn a_splash_opened_again_by_the_watchdog_is_waited_for() {
        // Arrange
        let t0 = Instant::now();
        let mut page = on_the_splash(t0);
        let watch = page.navigating(Page::Splash, t0);
        let at = t0 + watch.after;

        // Act
        let again = page.overdue(watch.id, at);

        // Assert
        assert!(again.is_some());
        assert_eq!(page.splash_route(at), SplashRoute::Wait);
    }

    #[test]
    fn commit_timeouts_grow_then_stay_at_the_last() {
        // Act
        let waits: Vec<u64> = [0, 1, 2, 3, 4, 100, u32::MAX].into_iter().map(|a| commit_timeout(a).as_secs()).collect();

        // Assert
        assert_eq!(waits, [5, 10, 20, 30, 30, 30, 30]);
    }
}
