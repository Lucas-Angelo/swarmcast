---
title: First run and the tutorial
description: What SwarmCast does the first time it opens, and the step-by-step tutorial in the panel.
---

When you open SwarmCast you see the **panel**, the screen where you control your live. It runs only on your computer: nobody else can open it.

## 1. SwarmCast starts

![The SwarmCast window while it starts: Starting SwarmCast… This usually takes a few seconds.](../../../assets/guides/start/en/splash.webp)

The window shows **Starting SwarmCast…** for a few seconds, then the setup tutorial opens by itself.

## 2. The setup tutorial

![Setup tutorial, step 1 of 9: Welcome to SwarmCast, with 1 Next.](../../../assets/guides/start/en/welcome.webp)

About 5 minutes. Click **Next** to go on, **Back** to go back. **Skip tutorial** closes it (you can open it again later).

## 3. Your PC check

![Step 2, Your PC check, while it runs: 1 Checking your computer… (memory, processor, internet speed, OBS). This takes about a minute.](../../../assets/guides/start/en/checking.webp)

The first time, SwarmCast checks your computer. It shows **Checking your computer…** for about a minute.

![Step 2 with the results: 1 a green tick next to the system, memory, processor, upload and download speed, disk, ports, OBS Studio, update server and version, and 2 Next.](../../../assets/guides/start/en/pc-check.webp)

A green tick means fine, a yellow one means it works but is not ideal. Nothing here stops you. At the same time SwarmCast downloads the free video converter (ffmpeg) for the smaller qualities.

## 4. OBS, once

![Step 4, Where will you stream?: 1 Another platform + SwarmCast at the same time (recommended), or 2 Only SwarmCast.](../../../assets/guides/start/en/where.webp)

Choose whether you also stream to Twitch, YouTube or Kick, or only to SwarmCast. The next steps show the OBS settings for that choice.

![Step 5: install the Multiple output plugin in OBS and fill in a new target with Name, URL (server) and Stream key: 1, 2 and 3 are their Copy buttons.](../../../assets/guides/start/en/obs-step.webp)

Use the **Copy** buttons and paste into OBS. The full walkthrough with OBS pictures: [Set up OBS](/swarmcast/start/obs/).

## 5. Test it and share the link

![Step 6, Test it: 1 SwarmCast is on, then Start Streaming in OBS.](../../../assets/guides/start/en/test-it.webp)

Start streaming in OBS. The tutorial shows when the video arrives.

![Step 7, Share the link: the live link (hidden here) and 1 Copy link.](../../../assets/guides/start/en/share-link.webp)

Every live gets a new secret link. Send it only to your members.

![Step 9, All set!: what to do at the end of a live, and 1 Finish.](../../../assets/guides/start/en/finish.webp)

Click **Finish**. To see the tutorial again, click **Redo setup tutorial** at the bottom of the panel.

## The panel

![The panel during a live: 1 Live: 3 viewers and OBS: sending, 2 the live link (hidden here), 3 OBS settings, 4 Viewers & P2P help (viewers who turned P2P on share video), 5 Live chat on the right, with the viewers' messages.](../../../assets/guides/start/en/panel.webp)

1. **At the top:** whether you are live, whether OBS is sending, and **Stop everything**.
2. **Live link for your subscribers:** the link to share. See [Go live](/swarmcast/live/go-live/).
3. **OBS settings:** the server and the stream key for OBS.
4. **Viewers & P2P help:** how many watch and how many help. See [Help the stream (P2P)](/swarmcast/live/p2p/).
5. **Live chat:** while you are live, the chat is right here, on the right (under the status in a narrow window): read, answer and moderate without scrolling. See [Chat](/swarmcast/live/chat/).

Further down: **Your internet**, **Connection mode**, **Protection** (see [Security and protection](/swarmcast/live/protection/)), **Quality for viewers**, **Desktop app** (start with the computer, updates), **Viewers** (kick someone), **Chat** (turn the chat on or off, chat settings), **Activity** and **Problem report** (send your logs). Most buttons have a small **ⓘ**: hover or tap it for an explanation.

## Where SwarmCast keeps your settings

Your settings, your stream key and the logs live in a SwarmCast folder in your user account. Updating SwarmCast never deletes it.

- Windows: `%LOCALAPPDATA%\SwarmCast`
- macOS: `~/Library/Application Support/SwarmCast`
- Linux: `~/.local/share/swarmcast`

Next: [Set up OBS](/swarmcast/start/obs/).
