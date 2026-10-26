// Command swarmcast-tray shows the SwarmCast tray / menu bar icon.
//
// It is a child process of SwarmCast and talks to it with JSON lines:
//
//	stdin:  {"type":"state","state":"off"|"waiting"|"live","tooltip":"...","canStart":bool,"canStop":bool}
//	        {"type":"quit"}
//	stdout: {"type":"ready"}                                   once the icon is up
//	        {"type":"click","id":"open"|"start"|"stop"|"quit"} on menu clicks
//
// It exits when stdin closes, so it never outlives SwarmCast.
package main

//go:generate go run ./icons/gen icons

import (
	"bufio"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"

	"fyne.io/systray"
)

//go:embed icons/*.png icons/*.ico
var icons embed.FS

type inMessage struct {
	Type     string `json:"type"`
	State    string `json:"state"`
	Tooltip  string `json:"tooltip"`
	CanStart bool   `json:"canStart"`
	CanStop  bool   `json:"canStop"`
}

type outMessage struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
}

var stdoutMu sync.Mutex

func send(m outMessage) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	// If the parent is gone the write fails; stdin EOF will end the process.
	_, _ = os.Stdout.Write(append(b, '\n'))
}

// iconFor returns the embedded icon for a state: ICO on Windows, PNG elsewhere.
func iconFor(state string) []byte {
	switch state {
	case "waiting", "live":
	default:
		state = "off"
	}
	ext := ".png"
	if runtime.GOOS == "windows" {
		ext = ".ico"
	}
	b, err := icons.ReadFile("icons/" + state + ext)
	if err != nil {
		log.Printf("missing icon for %q: %v", state, err)
	}
	return b
}

func setEnabled(item *systray.MenuItem, enabled bool) {
	if enabled {
		item.Enable()
	} else {
		item.Disable()
	}
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("swarmcast-tray: ")

	// SwarmCast decides when we quit: ignore terminal signals (Ctrl+C, closed terminal)
	// and turn SIGTERM into a clean exit that removes the icon.
	signal.Ignore(os.Interrupt, syscall.SIGHUP)
	term := make(chan os.Signal, 1)
	signal.Notify(term, syscall.SIGTERM)
	go func() {
		<-term
		quit()
	}()

	if runtime.GOOS == "linux" && os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		fmt.Fprintln(os.Stderr, "no desktop session (no D-Bus/X11/Wayland): running without a tray icon")
		os.Exit(3)
	}

	hideFromDock()
	systray.Run(onReady, func() {})
}

var quitOnce sync.Once

// quit removes the icon and ends the event loop. If the loop does not return in time,
// the process exits anyway: it must never outlive SwarmCast.
func quit() {
	quitOnce.Do(func() {
		go func() {
			time.Sleep(3 * time.Second)
			os.Exit(0)
		}()
		// On Linux without a usable D-Bus session, fyne's shutdown can panic on a nil
		// connection; we are quitting anyway, so exit cleanly instead of crashing.
		defer func() {
			if r := recover(); r != nil {
				os.Exit(0)
			}
		}()
		systray.Quit()
	})
}

func onReady() {
	systray.SetIcon(iconFor("off"))
	systray.SetTitle("")
	systray.SetTooltip("SwarmCast")

	open := systray.AddMenuItem("Open panel", "Open the SwarmCast panel in your browser")
	start := systray.AddMenuItem("Start", "Start the live")
	stop := systray.AddMenuItem("Stop everything", "End the live and close everything that is reachable")
	systray.AddSeparator()
	quitItem := systray.AddMenuItem("Quit", "Stop everything and quit SwarmCast")
	start.Disable()
	stop.Disable()

	go func() {
		for {
			select {
			case <-open.ClickedCh:
				send(outMessage{Type: "click", ID: "open"})
			case <-start.ClickedCh:
				send(outMessage{Type: "click", ID: "start"})
			case <-stop.ClickedCh:
				send(outMessage{Type: "click", ID: "stop"})
			case <-quitItem.ClickedCh:
				send(outMessage{Type: "click", ID: "quit"})
			}
		}
	}()

	go func() {
		current := "off"
		r := bufio.NewReader(os.Stdin)
		for {
			line, err := r.ReadBytes('\n')
			if len(line) > 0 {
				var m inMessage
				if jerr := json.Unmarshal(line, &m); jerr != nil {
					log.Printf("ignoring invalid message: %v", jerr)
				} else {
					switch m.Type {
					case "state":
						if m.State != current {
							current = m.State
							systray.SetIcon(iconFor(m.State))
						}
						systray.SetTooltip(m.Tooltip)
						setEnabled(start, m.CanStart)
						setEnabled(stop, m.CanStop)
					case "quit":
						quit()
						return
					default:
						log.Printf("ignoring unknown message type %q", m.Type)
					}
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					log.Printf("stdin: %v", err)
				}
				// The parent closed the pipe or died.
				quit()
				return
			}
		}
	}()

	send(outMessage{Type: "ready"})
}
