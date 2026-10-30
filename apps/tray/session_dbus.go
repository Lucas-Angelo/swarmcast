//go:build (linux || freebsd || openbsd || netbsd) && !android

package main

import "github.com/godbus/dbus/v5"

// connectSessionBus reaches the D-Bus session bus the way fyne.io/systray does: the shared
// connection, which systray then reuses instead of dialling again.
func connectSessionBus() error {
	_, err := dbus.SessionBus()
	return err
}
