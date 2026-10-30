package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The helper runs main() itself when the test binary is started with this variable (the
// process tests below): os.Exit and the real stderr are what SwarmCast sees.
const runMainEnv = "SWARMCAST_TRAY_TEST_MAIN"

func TestMain(m *testing.M) {
	if os.Getenv(runMainEnv) == "1" {
		main()
		return
	}
	os.Exit(m.Run())
}

func vars(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

func TestNoTray(t *testing.T) {
	noLauncher := errors.New(`exec: "dbus-launch": executable file not found in $PATH`)
	cases := []struct {
		name        string
		goos        string
		env         map[string]string
		connectErr  error
		want        string
		wantConnect bool
	}{
		{
			name:        "a Linux desktop whose session bus answers shows the icon",
			goos:        "linux",
			env:         map[string]string{"DISPLAY": ":0", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus"},
			want:        "",
			wantConnect: true,
		},
		{
			name: "Linux without any desktop session does not try the bus",
			goos: "linux",
			want: "no desktop session (no D-Bus/X11/Wayland)",
		},
		{
			name:        "a Linux display without a session bus has no tray",
			goos:        "linux",
			env:         map[string]string{"DISPLAY": ":99"},
			connectErr:  noLauncher,
			want:        `no D-Bus session bus (exec: "dbus-launch": executable file not found in $PATH)`,
			wantConnect: true,
		},
		{
			name:        "a Wayland session whose bus is gone has no tray",
			goos:        "linux",
			env:         map[string]string{"WAYLAND_DISPLAY": "wayland-0", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus"},
			connectErr:  errors.New("dial unix /run/user/1000/bus: connect: no such file or directory"),
			want:        "no D-Bus session bus (dial unix /run/user/1000/bus: connect: no such file or directory)",
			wantConnect: true,
		},
		{
			name:        "FreeBSD needs the session bus too",
			goos:        "freebsd",
			env:         map[string]string{"DISPLAY": ":0"},
			connectErr:  noLauncher,
			want:        `no D-Bus session bus (exec: "dbus-launch": executable file not found in $PATH)`,
			wantConnect: true,
		},
		{
			name:       "Windows needs no session bus",
			goos:       "windows",
			connectErr: noLauncher,
			want:       "",
		},
		{
			name:       "macOS needs no session bus",
			goos:       "darwin",
			connectErr: noLauncher,
			want:       "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Arrange
			connected := false
			connect := func() error {
				connected = true
				return c.connectErr
			}

			// Act
			got := noTray(c.goos, vars(c.env), connect)

			// Assert
			if got != c.want {
				t.Errorf("noTray() = %q, want %q", got, c.want)
			}
			if connected != c.wantConnect {
				t.Errorf("session bus tried: %v, want %v", connected, c.wantConnect)
			}
		})
	}
}

// The helper itself, as SwarmCast starts it on a display without a session bus: it says why on
// stderr, exits with code 3 and never starts the tray (nothing on stdout, no "ready").
func TestHelperWithoutSessionBusExitsWithoutTray(t *testing.T) {
	switch runtime.GOOS {
	case "linux", "freebsd", "openbsd", "netbsd":
	default:
		t.Skipf("the tray icon needs no session bus on %s", runtime.GOOS)
	}
	// Arrange
	dir, err := os.MkdirTemp("", "sc-tray-") // short: a socket path has at most 107 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	bus := filepath.Join(dir, "no-bus")
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), runMainEnv+"=1", "DISPLAY=:99", "WAYLAND_DISPLAY=", "DBUS_SESSION_BUS_ADDRESS=unix:path="+bus)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr

	// Act
	err = cmd.Run()

	// Assert
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != exitNoTray {
		t.Fatalf("exit: %v, want code %d; stderr: %s", err, exitNoTray, stderr.String())
	}
	want := "no D-Bus session bus (dial unix " + bus + ": connect: no such file or directory): running without a tray icon\n"
	if stderr.String() != want {
		t.Errorf("stderr = %q, want %q", stderr.String(), want)
	}
	if stdout.Len() != 0 || strings.Contains(stderr.String(), "panic") {
		t.Errorf("the tray started or panicked: stdout %q, stderr %q", stdout.String(), stderr.String())
	}
}
