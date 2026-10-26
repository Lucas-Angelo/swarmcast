---
title: Install on macOS
description: Install SwarmCast on a Mac (Apple chip or Intel) and allow it with "Open Anyway" the first time.
---

SwarmCast needs macOS 13.5 (Ventura) or newer.

## 1. Which Mac do you have?

Click the Apple menu (the apple at the top left of the screen) → **About This Mac**.

- **Chip: Apple M1, M2, M3, M4…** → you need the **Apple chip** file (its name ends in `aarch64.dmg`).
- **Processor: Intel…** → you need the **Intel chip** file (its name ends in `x64.dmg`).

## 2. Download and install

1. Go to the [download page](/swarmcast/download/#macos) and download the right `.dmg` file.
2. Double-click the `.dmg` in **Downloads**. A window opens.
3. Drag the **SwarmCast** icon onto the **Applications** folder.
4. Close the window. In Finder's sidebar, click the eject button next to **SwarmCast**.

## 3. Open it the first time ("Open Anyway")

macOS blocks apps that are not registered with Apple (a paid program). SwarmCast is free and open source, so you allow it once:

1. Open **Applications** and double-click **SwarmCast**.
2. A message says that Apple could not verify SwarmCast (or "SwarmCast Not Opened"). Click **Done** (or **OK**). Do not click **Move to Trash**.
3. Open the Apple menu → **System Settings** → **Privacy & Security**.
4. Scroll down to **Security**. Next to "SwarmCast was blocked…", click **Open Anyway**.
5. Confirm with your password or Touch ID, then click **Open Anyway** once more.

From now on SwarmCast opens normally. Its icon also appears in the menu bar at the top of the screen.

:::tip[Is that safe?]
The warning only means SwarmCast is not registered with Apple. Its source code is public, and every update the app installs is checked with a digital signature first.
:::

## 4. First run

The window shows **Starting SwarmCast…** and then a short tutorial. Continue with [First run and the tutorial](/swarmcast/start/first-run/).

If macOS asks whether SwarmCast may accept incoming network connections (this can happen when you use [Direct mode](/swarmcast/live/direct-mode/)), click **Allow**. In the normal Secure mode, viewers never connect to your Mac.

## Something went wrong?

- **"SwarmCast is damaged and can't be opened":** first delete the app and the `.dmg`, download it again and repeat the steps (the download may have been cut). If it still says so, open **Terminal** (Applications → Utilities) and paste `xattr -dr com.apple.quarantine /Applications/SwarmCast.app`, press Enter, and open SwarmCast again. That removes the "downloaded from the internet" mark from SwarmCast only.
- **No "Open Anyway" button:** it appears only for about an hour after you tried to open the app. Double-click SwarmCast again, then go back to **Privacy & Security**.
- More answers: [Troubleshooting](/swarmcast/help/troubleshooting/).
