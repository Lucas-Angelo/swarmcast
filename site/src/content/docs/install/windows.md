---
title: Install on Windows
description: Download and install SwarmCast on Windows 10 or 11, including the "Windows protected your PC" warning.
---

SwarmCast installs for your Windows user only. It does not need administrator rights, and it does not change OBS.

## 1. Download

1. Go to the [download page](/swarmcast/download/#windows).
2. Download the file that ends in **`x64-setup.exe`** (for example `SwarmCast_0.2.0_x64-setup.exe`).

## 2. Run the installer

1. Open your **Downloads** folder and double-click the file.
2. The first time, Windows may show a blue window: **"Windows protected your PC"**. This happens with every new app that is not from a big company. It does not mean something is wrong.
   1. Click **More info**.
   2. Click **Run anyway**.
3. If Windows asks **"Do you want to run this file?"**, click **Run**.
4. The installer opens in English or Portuguese, following your Windows language. Click **Next** and **Install**. It takes a few seconds.
5. On the last page, leave **Run SwarmCast** ticked and click **Finish**.

:::tip[Why the warning?]
SmartScreen warns about apps that are new or have no paid code-signing certificate. SwarmCast is free and open source, so it has no paid certificate. Its source code is public, and every update the app installs is checked with a digital signature first.
:::

## 3. Open SwarmCast

SwarmCast now has a shortcut on the desktop and in the Start menu. It opens in its own window and puts an icon next to the clock (the tray). If you don't see the icon, click the small arrow **^** next to the clock.

The first time, the window shows **Starting SwarmCast…** and then a short tutorial. Continue with [First run and the tutorial](/swarmcast/start/first-run/).

:::note
When you turn on Direct mode for the first time (only for emergencies, see [Direct mode](/swarmcast/live/direct-mode/)), Windows may ask whether SwarmCast may use networks. Click **Allow** (Private networks).
:::

## Something went wrong?

- **The download disappeared, or the browser says it is "not commonly downloaded":** in Edge open the downloads list (**Ctrl+J**), click **…** next to the file, then **Keep** → **Show more** → **Keep anyway**.
- **Installing again while SwarmCast is open:** the installer closes SwarmCast first, which ends a live that is on. Install when you are not live.
- More answers: [Troubleshooting](/swarmcast/help/troubleshooting/).
