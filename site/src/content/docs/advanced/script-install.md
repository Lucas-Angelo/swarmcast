---
title: "Advanced: install with a script"
description: Install SwarmCast with the start scripts or the installer zip, without the desktop app - for advanced users and servers.
---

Most people should use the [desktop app](/swarmcast/download/). The scripts are for advanced users, servers and computers where the app cannot be installed. Both use the same SwarmCast and the same settings folder, but do not run both at the same time.

With the scripts, SwarmCast runs in a terminal window and the panel opens in your browser. There is a small tray icon, but no automatic updates and no "Start with the computer".

## Option 1: the installer zip

1. Download the zip for your computer from the [latest release](https://github.com/Lucas-Angelo/swarmcast/releases/latest):
   - Windows: `SwarmCast-vX.Y.Z-windows-x64-installer.zip`
   - Mac with an Apple chip (M1 or newer): `SwarmCast-vX.Y.Z-macos-arm64-installer.zip`
   - Mac with an Intel chip: `SwarmCast-vX.Y.Z-macos-x64-installer.zip`
   - Linux: `SwarmCast-vX.Y.Z-linux-x64-installer.zip` (or `linux-arm64`)
2. Extract it. Do not run anything from inside the zip.
   - Windows: right-click the zip → **Extract All…** → **Extract**.
   - macOS: double-click the zip.
   - Linux: right-click → **Extract Here**.
3. Open the extracted folder and start the script:
   - **Windows:** double-click `start-windows.cmd`. The first time, Windows may show "Windows protected your PC": click **More info** → **Run anyway**. If it asks "Do you want to run this file?", click **Run**.
   - **macOS:** double-click `start-macos.command`. The first time, macOS blocks it: click **Done**, open **System Settings** → **Privacy & Security**, scroll down, click **Open Anyway** and confirm. On older macOS: right-click the file → **Open** → **Open**.
   - **Linux:** open a terminal in the folder and run `./start-linux.sh`.

The zip also has this guide as an offline page: `READ-ME - How to go live.html` and `LEIA-ME - Como fazer a live.html`.

## Option 2: one command

Paste in a terminal (Windows: PowerShell; macOS: Terminal):

- Windows: `irm https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/start-windows.ps1 | iex`
- macOS: `curl -fsSL https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/start-macos.sh | bash`
- Linux: `curl -fsSL https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/start-linux.sh | bash`

## What the script does

1. It checks your computer: memory, processor, disk, internet speed and OBS. ✓ means fine, ⚠ means it works but is not ideal, ✗ means too low. It never asks questions: below the minimum it shows a warning and continues.
2. On Linux, if basic tools are missing, it explains why and asks for your password (`sudo`) to install them. Nothing else needs administrator rights.
3. It installs or updates SwarmCast for your user and checks that the files are intact (SHA-256). It also downloads the free video converter (ffmpeg) for the smaller qualities.
4. If something fails it tries again by itself, and goes back to the previous version if an update fails. If it still fails, it tells you what to do and waits for Enter before closing.
5. The SwarmCast panel opens in your browser, with the [setup tutorial](/swarmcast/start/first-run/) the first time.

**Keep the window open while you stream.** Closing it turns SwarmCast off.

## Every live

Start the script again (double-click, or the same command), then follow [Go live and share the link](/swarmcast/live/go-live/). Quit with the tray icon → **Quit SwarmCast**, the **Quit SwarmCast** button in the panel, or by closing the window.

## Updating

- **Installer zip:** extract the new zip and run its script the same way. Your settings and stream key are kept. You can delete the old folder.
- **One command:** run the same command again.

If an update fails, the previous version keeps working. An old zip never replaces a newer version that is already installed.

## Script options

Add them after the script name or the command, for example `./start-linux.sh --no-tunnel`:

- `--no-tunnel`: local only, no public link (for tests).
- `--install-only`: install or update without starting.
- `--skip-speedtest`: skip the internet speed test.
- `--no-ffmpeg`: do not download the video converter.
- `--ask`: ask before continuing on a computer below the minimum.

On Windows the same options also work as `-NoTunnel`, `-NoFfmpeg`, `-Ask` and so on.

## Problems with the scripts

- **"Could not download SwarmCast" or "HTTP 404":** you ran the script outside the extracted folder (or inside the zip). Extract the zip and run the script from the extracted folder.
- **"Port … is busy":** another SwarmCast (for example the desktop app) or another program uses port 1935, 8080 or 8081. Quit it and run the script again.

To uninstall, see [Uninstall](/swarmcast/app/uninstall/#remove-everything-uninstall-script).
