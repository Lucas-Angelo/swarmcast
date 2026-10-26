//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

static void swarmcastHideFromDock(void) {
	// Accessory apps have a menu bar item but no Dock icon and no app menu. An unbundled
	// binary already behaves like this, but a helper shipped inside an .app bundle would
	// inherit the bundle's regular policy, so set it explicitly.
	[[NSApplication sharedApplication] setActivationPolicy:NSApplicationActivationPolicyAccessory];
}
*/
import "C"

// hideFromDock must run on the main thread (systray locks it in init) before systray.Run.
func hideFromDock() {
	C.swarmcastHideFromDock()
}
