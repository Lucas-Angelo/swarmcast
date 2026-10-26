//go:build !darwin

package main

// hideFromDock is only needed on macOS.
func hideFromDock() {}
