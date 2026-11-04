#!/usr/bin/env python3
"""WebKitGTK harness for the desktop window's panel load (docs/DESKTOP.md, "Panel load watchdog").

The desktop window shows the splash (a custom scheme page, like Tauri's tauri://localhost), then
navigates to the panel's /auth/<token> page on 127.0.0.1, which answers with
Cross-Origin-Opener-Policy: same-origin and opens / by itself (meta refresh). WebKit's COOP process
swap can lose that navigation: it never commits and never fails. This script repeats the window's
navigations with WebKitGTK 4.1 (the library Tauri uses on Linux) against a local server that sends
the panel's headers, and counts the loads that never commit. Run it with webkit.sh race.

  --pattern app        one webview: splash, /auth, /, splash again...
  --pattern app-fresh  a new webview per load (an app start): its splash, then /auth and /
  --pattern blank      a new webview per load whose first page is /auth

  --mode observe   a load that has not committed in --stall-s seconds is watched for --confirm-s
                   more (a stall that lasts is the bug), then navigated again, as the app's
                   watchdog does, to check that a new navigation recovers it.
  --mode watchdog  the app's own schedule: navigate again after 5 s, then 10 s, 20 s, 30 s...
                   (apps/desktop/src-tauri/src/page.rs, COMMIT_TIMEOUTS).

Prints one JSON line with the counts and exits 1 if a load never committed in the end.
"""

import argparse
import http.server
import json
import sys
import threading
import time

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gio, GLib, Gtk, WebKit2  # noqa: E402

SPLASH = b'<!doctype html><meta charset="utf-8"><title>splash</title><p>Starting SwarmCast...</p>'
AUTH = (b'<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/">'
        b'<title>SwarmCast panel</title><h1>Opening the panel...</h1><p><a href="/">Open the panel</a></p>')
PANEL = b'<!doctype html><meta charset="utf-8"><title>panel</title><p>panel</p>'
# The panel's security headers (apps/server/src/http/security-headers.ts) and CSP (admin/server.ts).
HEADERS = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
                               "font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
}


class Panel(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    coop = True

    def do_GET(self):  # noqa: N802 (http.server's name)
        body = AUTH if self.path.startswith('/auth/') else PANEL
        self.send_response(200)
        for k, v in HEADERS.items():
            if k != 'Cross-Origin-Opener-Policy' or Panel.coop:
                self.send_header(k, v)
        if self.path.startswith('/auth/'):
            self.send_header('Set-Cookie', 'sc_admin=x; Path=/; HttpOnly; SameSite=Strict')
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def schedule(attempt):
    """The app's re-navigation delays (page.rs): 5 s, 10 s, 20 s, then 30 s."""
    return [5, 10, 20, 30][min(attempt, 3)]


class Run:
    def __init__(self, args, base):
        self.a = args
        self.base = base
        self.n = 0
        self.stats = {'loads': 0, 'stalls': 0, 'renavigations': 0, 'recovered': 0, 'never_committed': 0,
                      'failed': 0, 'refresh_stalls': 0, 'splash_stalls': 0, 'max_commit_ms': 0}
        self.start = time.monotonic()
        self.win = Gtk.Window()
        self.win.set_default_size(800, 600)
        self.ctx = WebKit2.WebContext.get_default()
        # As wry registers Tauri's scheme (wry 0.57 webkitgtk/web_context.rs): secure, answered
        # asynchronously from the main loop.
        self.ctx.get_security_manager().register_uri_scheme_as_secure('tauri')
        self.ctx.register_uri_scheme('tauri', self.on_scheme)
        self.view = None
        self.new_view()
        self.win.show_all()
        self.target = None  # 'splash' | 'auth' | 'panel'
        self.token = 0  # increments per navigation the harness starts
        self.attempt = 0
        self.started = 0.0
        self.confirming = False

    def new_view(self):
        """A new webview, as a new app window gets (its first page is about:blank)."""
        if self.view is not None:
            self.win.remove(self.view)
            self.view.destroy()
        self.view = WebKit2.WebView.new_with_context(self.ctx)
        self.view.get_settings().set_enable_page_cache(True)  # wry's setting
        self.view.connect('load-changed', self.on_load)
        self.view.connect('load-failed', self.on_failed)
        self.win.add(self.view)
        self.view.show()

    # ---- pages ----

    def on_scheme(self, request):
        def answer():
            stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(SPLASH))
            response = WebKit2.URISchemeResponse.new(stream, len(SPLASH))
            response.set_content_type('text/html')
            request.finish_with_response(response)
            return False
        GLib.idle_add(answer)

    def navigate(self, target, url, renavigation=False):
        self.target = target
        self.url = url
        self.token += 1
        if not renavigation:
            self.attempt = 0
            self.started = time.monotonic()
        self.confirming = False
        if not renavigation:
            self.events = []
        token = self.token
        self.view.load_uri(url)
        delay = self.a.stall_s if self.a.mode == 'observe' else schedule(self.attempt)
        GLib.timeout_add(int(delay * 1000), self.on_timeout, token)

    def splash(self):
        self.navigate('splash', 'tauri://localhost/index.html')

    def auth(self):
        self.n += 1
        self.stats['loads'] += 1
        self.navigate('auth', f'{self.base}/auth/t{self.n}')

    # ---- events ----

    def on_load(self, view, event):
        uri = view.get_uri() or ''
        self.events.append(f'{event.value_nick}:{uri.split("://")[0]}:{uri.rsplit("/", 1)[-1][:12]}')
        if event == WebKit2.LoadEvent.COMMITTED:
            if self.target == 'auth' and '/auth/' in uri:
                ms = int((time.monotonic() - self.started) * 1000)
                self.stats['max_commit_ms'] = max(self.stats['max_commit_ms'], ms)
                if self.attempt > 0:
                    self.stats['recovered'] += 1
                    print(f'auth load #{self.n} committed {ms} ms after its first try, after {self.attempt} '
                          f'new navigation(s) (events since: {" ".join(self.events)})', file=sys.stderr, flush=True)
                self.target = 'panel'
                self.token += 1  # the meta refresh is the page's own navigation, watched below
                self.started = time.monotonic()
                GLib.timeout_add(int(self.a.confirm_s * 1000), self.on_refresh_timeout, self.token)
            elif self.target == 'panel' and uri.rstrip('/') == self.base:
                self.token += 1
            elif self.target == 'splash' and uri.startswith('tauri:'):
                if self.attempt > 0:
                    self.stats['recovered'] += 1
                self.token += 1
        elif event == WebKit2.LoadEvent.FINISHED:
            if self.target == 'panel' and uri.rstrip('/') == self.base:
                self.target = None
                GLib.idle_add(self.next_cycle)
            elif self.target == 'splash' and uri.startswith('tauri:'):
                self.target = None
                GLib.idle_add(self.auth)

    def on_failed(self, _view, _event, uri, error):
        # A cancelled load (our own re-navigation) reports here too.
        if error.matches(WebKit2.NetworkError.quark(), WebKit2.NetworkError.CANCELLED):
            return False
        self.stats['failed'] += 1
        print(f'load failed: {uri}: {error.message}', file=sys.stderr, flush=True)
        return False

    def on_timeout(self, token):
        if token != self.token:
            return False  # committed (or superseded) in time
        if self.a.mode == 'observe' and not self.confirming:
            # Watch it longer: a load that is only slow commits meanwhile.
            self.confirming = True
            GLib.timeout_add(int(self.a.confirm_s * 1000), self.on_timeout, token)
            return False
        if self.attempt == 0:
            key = 'stalls' if self.target == 'auth' else 'splash_stalls'
            self.stats[key] += 1
            print(f'{self.target} load #{self.n} did not commit in {time.monotonic() - self.started:.1f} s '
                  f'(events: {" ".join(self.events) or "none"})', file=sys.stderr, flush=True)
            self.events = []
        if self.attempt >= self.a.max_attempts:
            self.stats['never_committed'] += 1
            self.finish()
            return False
        self.attempt += 1
        self.stats['renavigations'] += 1
        self.navigate(self.target, self.url, renavigation=True)
        return False

    def on_refresh_timeout(self, token):
        if token == self.token:
            self.stats['refresh_stalls'] += 1
            print(f'meta refresh of load #{self.n} did not commit', file=sys.stderr, flush=True)
            self.stats['never_committed'] += 1
            self.finish()
        return False

    def next_cycle(self):
        if self.n >= self.a.loads or time.monotonic() - self.start > self.a.max_s:
            self.finish()
            return False
        if self.a.pattern != 'app':
            self.new_view()
        if self.a.pattern == 'blank':
            self.auth()
        else:
            self.splash()
        return False

    def finish(self):
        self.stats['seconds'] = int(time.monotonic() - self.start)
        self.stats['webkit'] = f'{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}'
        self.stats['mode'] = self.a.mode
        self.stats['pattern'] = self.a.pattern
        self.stats['coop'] = Panel.coop
        print(json.dumps(self.stats), flush=True)
        self.code = 1 if self.stats['never_committed'] or self.stats['failed'] else 0
        Gtk.main_quit()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--mode', choices=['observe', 'watchdog'], default='observe')
    p.add_argument('--pattern', choices=['app', 'app-fresh', 'blank'], default='app')
    p.add_argument('--loads', type=int, default=1000)
    p.add_argument('--max-s', type=float, default=3600)
    p.add_argument('--stall-s', type=float, default=5)
    p.add_argument('--confirm-s', type=float, default=20)
    p.add_argument('--max-attempts', type=int, default=8)
    p.add_argument('--no-coop', action='store_true')
    a = p.parse_args()
    Panel.coop = not a.no_coop
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Panel)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    run = Run(a, f'http://127.0.0.1:{srv.server_address[1]}')
    run.code = 1
    GLib.idle_add(run.next_cycle)
    Gtk.main()
    sys.exit(run.code)


if __name__ == '__main__':
    main()
