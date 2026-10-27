---
title: Uninstall
description: Remove SwarmCast from Windows, macOS or Linux, with or without your settings and stream key.
---

Uninstalling never changes OBS. If you want, remove the SwarmCast target (Multiple output panel), the Vertical streaming settings (Aitum Vertical) or the custom server from OBS yourself.

## Windows

1. Quit SwarmCast (tray icon → **Quit**).
2. Open **Settings** → **Apps** → **Installed apps**, find **SwarmCast**, click **…** → **Uninstall**.
3. The uninstaller keeps your settings and stream key, unless you tick **delete app data**.

## macOS

1. Quit SwarmCast (menu bar icon → **Quit**).
2. If **Start with the computer** is on, turn it off first in the panel ([Start with the computer](/swarmcast/app/autostart/)).
3. Open **Applications** and drag **SwarmCast** to the Trash.
4. Your settings stay in `~/Library/Application Support/SwarmCast`. To remove everything, use the uninstall script below.

## Linux

- **.deb:** in a terminal, `sudo apt remove swarm-cast`.
- **AppImage:** turn off **Start with the computer** in the panel, quit SwarmCast and delete the `.AppImage` file.

Your settings stay in `~/.local/share/swarmcast`. To remove everything, use the uninstall script below.

## Remove everything (uninstall script)

The uninstall script removes SwarmCast completely: the app, its "start with the computer" entry, your settings, your stream key and the logs. It also closes a router port that Direct mode may have left open. It asks nothing.

1. Download the uninstaller for your system from the [latest release](https://github.com/Lucas-Angelo/swarmcast/releases/latest) (it is also inside the installer zips of the [script install](/swarmcast/advanced/script-install/)):
   - Windows: `uninstall-windows.cmd` **and** `uninstall-windows.ps1` (keep them in the same folder)
   - macOS: `uninstall-macos.command`
   - Linux: `uninstall-linux.sh`
2. Run it:
   - **Windows:** double-click `uninstall-windows.cmd`. If you see "Windows protected your PC", click **More info** → **Run anyway**.
   - **macOS:** double-click `uninstall-macos.command`. If macOS blocks it, allow it like the app: **System Settings** → **Privacy & Security** → **Open Anyway** (on older macOS: right-click the file → **Open** → **Open**).
   - **Linux:** in a terminal in that folder: `bash uninstall-linux.sh`
3. The window shows the result. On Windows, press a key to close it.

Want to reinstall later with the same stream key? Add `--keep-settings`, for example `uninstall-windows.cmd --keep-settings` or `bash uninstall-linux.sh --keep-settings` in a terminal.
