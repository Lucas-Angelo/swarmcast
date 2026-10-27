---
title: Go live and share the link
description: Every live, step by step - turn SwarmCast on, start OBS, share the secret link and stop everything at the end.
---

## Every live

### 1. Open SwarmCast

It turns on by itself and shows **Waiting for OBS to start streaming…**. If the top of the panel says **Off**, click **Turn on SwarmCast**.

### 2. Start streaming in OBS

![OBS Controls and the Multiple output panel: 1 Start Streaming, 2 Start next to SwarmCast.](../../../assets/guides/obs/en/start-both.webp)

Click **Start Streaming** as always. With the Multiple output plugin, SwarmCast starts with it if you ticked "Sync start"; otherwise also click **Start** next to SwarmCast. Setup: [Set up OBS](/swarmcast/start/obs/).

### 3. Wait for "OBS: sending"

![The top of the panel: 1 OBS: sending · 2.6 Mbps under Live: 3 viewers, and 2 Stop everything.](../../../assets/guides/live/en/status-live.webp)

The top of the panel turns to **Live** and shows **OBS: sending**.

### 4. Copy the link and send it

![The Live link for your subscribers card: the link (hidden here), 1 Copy link, 2 Generate new link, 3 Disconnect everyone.](../../../assets/guides/live/en/link-card.webp)

Click **Copy link** and send it only to your members, for example in a subscribers-only Discord channel. Every live gets a new link.

Your members open the link, type a nickname and watch in the browser. See [For viewers](/swarmcast/viewers/).

:::caution[Keep the link among members]
Anyone who has the link can watch. If it leaks, click **Generate new link** and send the new one. See [Kick a viewer and make a new link](/swarmcast/live/kick-and-new-link/).
:::

## The OBS settings card

![The OBS settings card: Server rtmp://127.0.0.1:1935/live with 1 Copy, the hidden Stream key with 2 Copy, and 3 OBS is sending video (2.6 Mbps).](../../../assets/guides/live/en/obs-card.webp)

The two things OBS needs, each with a **Copy** button. The key stays hidden: **never show it on stream or in a screenshot**. A green **OBS is sending video** means OBS is connected.

## During the live

- **Viewers & P2P help:** how many watch and how many help through P2P.
- **Your upload now:** how much of your upload SwarmCast uses. It never goes above **Max upload for viewers**.
- **Warnings** at the top, for example **"Too many viewers for your upload"**: ask viewers to turn on **Help the stream (P2P)**, which is off by default ([Help the stream](/swarmcast/live/p2p/)).

## When you finish

1. Stop streaming in OBS.
2. In the panel click **Stop everything** and wait for this:

![The top of the panel after Stop everything: 1 Off: nothing on your computer is reachable, and 2 Turn on SwarmCast for the next live.](../../../assets/guides/live/en/stopped.webp)

If OBS sends no video for 10 minutes, SwarmCast turns everything off by itself (**Turn off after … minutes without video** in the panel).

## Closing the window

![The question when you close the window during a live: The live is on. Closing stops it for everyone. 1 Stop and quit, 2 Keep running in the tray.](../../../assets/guides/live/en/close-dialog.webp)

If you close the window while you are live, SwarmCast asks: **Stop and quit** ends the live; **Keep running in the tray** hides the window and the live goes on.

![The SwarmCast menu in the macOS menu bar: 1 the icon, then Open SwarmCast, Start live, Stop live, Check for updates, Export logs… and Quit.](../../../assets/guides/live/en/tray.webp)

The icon sits in the menu bar (Mac) or next to the clock (Windows, Linux; click the small arrow **^** if you don't see it). Its menu has **Open SwarmCast**, **Start live** / **Stop live**, **Check for updates**, **Export logs…** and **Quit**.
