---
title: Install on Linux
description: Install SwarmCast on Linux with the .deb package (Ubuntu, Debian, Mint) or the AppImage (any distribution).
---

There are two files. Pick one:

- **`.deb`**: for Ubuntu, Debian, Linux Mint, Pop!_OS and other Debian-based systems. It installs like any other app and adds SwarmCast to your app menu.
- **`.AppImage`**: one file that runs on almost any distribution (Fedora, Arch, openSUSE…) without installing. It also updates itself.

Most computers need the **x64** (`amd64`) files. Use the **arm64** (`aarch64`) ones only on ARM computers, such as a Raspberry Pi 5.

## Option A: the .deb package

1. Go to the [download page](/swarmcast/download/#linux) and download the `.deb` file (for example `swarmcast_0.2.1_amd64.deb`).
2. Install it:
   - **With the mouse:** double-click the file. Your software center opens. Click **Install** and type your password.
   - **In a terminal**, in the Downloads folder: `sudo apt install ./swarmcast_*_amd64.deb`
3. Open **SwarmCast** from your app menu.

`apt` also installs the two system libraries SwarmCast needs (WebKitGTK and the tray icon library).

## Option B: the AppImage

1. Download the `.AppImage` file from the [download page](/swarmcast/download/#linux).
2. Allow it to run: right-click the file → **Properties** → **Permissions** → tick **Allow executing file as program** (or in a terminal: `chmod +x SwarmCast_*.AppImage`).
3. Double-click it.

The AppImage uses the usual desktop libraries (fonts, graphics/OpenGL), which every desktop distribution already has. On a minimal install without a full desktop, use the `.deb` instead.

:::caution[Ubuntu 22.04 or newer: "AppImages require FUSE to run"]
Install the FUSE 2 library once, then try again:

- Ubuntu 24.04 and newer: `sudo apt install libfuse2t64`
- Ubuntu 22.04: `sudo apt install libfuse2`
:::

Keep the AppImage in a fixed place (for example a folder called `Applications` in your home folder) before you turn on [Start with the computer](/swarmcast/app/autostart/), because that setting remembers where the file is.

## First run

The window shows **Starting SwarmCast…** and then a short tutorial. Continue with [First run and the tutorial](/swarmcast/start/first-run/).

:::note[No tray icon on GNOME?]
Ubuntu shows the icon by itself. On other GNOME desktops, install the "AppIndicator and KStatusNotifierItem Support" extension, or simply use the SwarmCast window.
:::

More answers: [Troubleshooting](/swarmcast/help/troubleshooting/).
