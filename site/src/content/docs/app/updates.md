---
title: Updates
description: How SwarmCast tells you about new versions and updates itself with one click, keeping your settings.
---

SwarmCast looks for a new **stable** version shortly after it opens and then every 6 hours. Nothing is installed without your OK.

## When there is a new version

A message says **"SwarmCast X is available (you have Y)"** with what's new, and the panel shows the same as a banner.

1. Click **Update now** (or **Later**).
2. SwarmCast downloads the update, checks its digital signature, installs it and **opens again by itself**. It takes about a minute.

Your settings, your stream key and your viewers' access are kept.

:::caution[Updating stops the live]
If you are live, updating ends the live for everyone. SwarmCast warns you first, and **Later** is the default. Update when the live is over.
:::

## Check now

Click **Check for updates** in the panel's **Desktop app** card, or in the tray menu.

## If an update fails

The version you have keeps working. SwarmCast retries the download a few times by itself. If it still fails, check your internet connection and click **Try again** later.

## Linux

- **AppImage:** updates itself like on Windows and macOS.
- **.deb:** if the app cannot install the update by itself, it opens the download page. Download the new `.deb` and install it the same way as the first time ([Install on Linux](/swarmcast/install/linux/)). Your settings are kept.

## Script install

If you installed with a script, run the same script (or the one from a new installer zip) again. It updates SwarmCast and keeps your settings. See [Advanced: install with a script](/swarmcast/advanced/script-install/).

## How SwarmCast checks (privacy)

To check, the app downloads a small public file (`latest.json`) from the SwarmCast releases on GitHub. It sends nothing about you or your live. GitHub counts how many times that file was downloaded, which is how this site can estimate how many apps are in use. More in [Privacy and usage numbers](/swarmcast/about/privacy/).
