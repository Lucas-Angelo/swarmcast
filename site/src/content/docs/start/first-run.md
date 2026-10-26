---
title: First run and the tutorial
description: What SwarmCast does the first time it opens, and the step-by-step tutorial in the panel.
---

When you open SwarmCast, you see the **panel**: the screen where you control your live. It runs only on your computer. Nobody else can open it.

## What happens the first time

1. The window shows **Starting SwarmCast…** for a few seconds.
2. SwarmCast checks your computer: memory, processor, internet speed and whether OBS is installed. This takes about a minute. ✓ means fine, ⚠ means it works but is not ideal. Nothing here stops you.
3. It downloads the free video converter (ffmpeg) straight from its publisher and checks it. It lets viewers with slow internet pick a smaller quality. If the download fails, SwarmCast tries again by itself, and everything still works with your original quality.
4. The **setup tutorial** opens.

## The setup tutorial

The tutorial takes about 5 minutes and has pictures of OBS. It walks you through:

1. **Your PC check:** what SwarmCast found on this computer.
2. **OBS output settings:** the keyframe interval of 2 seconds (required).
3. **Where will you stream?** Another platform (Twitch, YouTube, Kick…) and SwarmCast at the same time, or only SwarmCast.
4. **Send OBS to SwarmCast:** the server and the stream key, with **Copy** buttons.
5. **Test it:** you start streaming in OBS and the tutorial shows when the video arrives.
6. **Share the link** and a quick tour of the panel.

The same steps are explained on this site: [Set up OBS](/swarmcast/start/obs/) and [Go live and share the link](/swarmcast/live/go-live/).

To see the tutorial again, click **Redo setup tutorial** at the bottom of the panel.

![The SwarmCast panel during a live: Live and OBS: sending at the top, the live link card (the link is hidden here), and the list of viewers with their device and P2P.](../../../../../docs/img/panel-overview-en.png)

## The parts of the panel

- **At the top:** whether you are live, whether OBS is sending, and the **Stop everything** button.
- **Live link for your subscribers:** the secret link to share, with **Copy link** and **Generate new link**.
- **Viewers & P2P help:** who is watching (nickname and device) and who is helping by sharing video.
- **Quality for viewers** and **Your internet:** the smaller qualities and how much of your upload SwarmCast uses.
- **Connection mode:** Secure mode (normal) or Direct mode (emergencies only).
- **Protection:** what SwarmCast detected and did against attacks.
- **Desktop app:** start with the computer, version and updates.
- **Activity:** everything that happens during the live. Copy it when you ask for help.
- **At the bottom:** the language, **Help** (this site), **Redo setup tutorial** and **Quit SwarmCast**.

Most buttons have a small **ⓘ** next to them: hover or tap it for an explanation.

## Where SwarmCast keeps your settings

Your settings, your stream key and the logs are in a SwarmCast folder in your user account. Updating SwarmCast never deletes it.

- Windows: `%LOCALAPPDATA%\SwarmCast`
- macOS: `~/Library/Application Support/SwarmCast`
- Linux: `~/.local/share/swarmcast`

Next: [Set up OBS](/swarmcast/start/obs/).
