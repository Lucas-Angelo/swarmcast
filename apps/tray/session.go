package main

import "fmt"

// exitNoTray is the exit code for "this desktop cannot show a tray icon": SwarmCast then runs
// with its panel only and does not start the helper again (apps/server/src/tray/tray.ts).
const exitNoTray = 3

// noTray says why this desktop cannot show the tray icon, or "" when it can. On Linux and the
// BSDs the icon is a StatusNotifierItem on the D-Bus session bus (fyne.io/systray), so it needs a
// desktop session whose session bus answers; connect reaches that bus. Without the bus, systray
// starts anyway, shows nothing and panics on its nil connection when it quits.
func noTray(goos string, getenv func(string) string, connect func() error) string {
	switch goos {
	case "linux", "freebsd", "openbsd", "netbsd":
	default:
		return ""
	}
	if getenv("DBUS_SESSION_BUS_ADDRESS") == "" && getenv("DISPLAY") == "" && getenv("WAYLAND_DISPLAY") == "" {
		return "no desktop session (no D-Bus/X11/Wayland)"
	}
	if err := connect(); err != nil {
		return fmt.Sprintf("no D-Bus session bus (%v)", err)
	}
	return ""
}
