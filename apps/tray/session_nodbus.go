//go:build !((linux || freebsd || openbsd || netbsd) && !android)

package main

// connectSessionBus has nothing to reach: the icon needs no session bus here (Windows, macOS).
func connectSessionBus() error {
	return nil
}
