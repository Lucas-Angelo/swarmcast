# swarmcast-tray

Tiny Go helper ([fyne.io/systray](https://github.com/fyne-io/systray)) that shows the tray / menu bar icon. SwarmCast starts it and talks to it over stdin/stdout JSON lines (protocol in `main.go`); it exits when stdin closes.

Build: `node apps/tray/build.mjs [--target windows-x64|macos-arm64|macos-x64|linux-x64|linux-arm64] [--vendor]` → `apps/tray/bin/<target>/` (`--vendor` also copies it to `vendor/<target>/` for dev mode). Needs Go 1.23+.

- **macOS**: Xcode Command Line Tools (`xcode-select --install`); cgo is required, so build on a Mac (arm64 and x64 both work from either).
- **Windows**: nothing else (pure Go, built with `-H=windowsgui` so no console window appears).
- **Linux**: nothing else to build (pure Go over DBus, no GTK/libappindicator). At runtime the desktop needs a StatusNotifierItem host (KDE, Xfce, Cinnamon, Ubuntu GNOME; plain GNOME needs the AppIndicator extension). Without one, SwarmCast simply runs with the panel only.

Icons: copies of the brand tray icons (`assets/brand/tray/tray-<state>-32.png` and `tray-<state>.ico`; off grey, waiting honey, live red), the same ones the desktop app uses. Re-copy them when the brand changes.
