---
title: Qualities (1080p, 720p, 480p and Auto)
description: How SwarmCast offers smaller qualities to viewers with slow internet, automatically and without slowing OBS down.
---

Your viewers always get your **original quality** (what OBS sends, for example 1080p). When your computer can do it safely, SwarmCast also makes **smaller copies** (720p, 480p and 360p), so viewers on weak Wi-Fi or mobile data keep watching without pauses.

## It is automatic

- SwarmCast checks your computer when it starts. With a **graphics chip** that can convert video (NVIDIA, AMD, Intel, Apple), it offers 720p, 480p and 360p, with almost no processor cost.
- Without one, it runs a short test on the processor and offers **one** small quality only if there is room to spare.
- The viewer's player picks the best quality their internet can play without pausing (**Auto**), and changes it when needed. Viewers can also pick a quality by hand.

![The Quality for viewers card: 1 Stream in multiple qualities (automatic), 2 Viewers get: 1080p, 720p, 480p, 360p, and 3 Upload used by SwarmCast.](../../../assets/guides/live/en/quality-card.webp)

## OBS always comes first

The converter runs at low priority. If it falls behind or your processor is almost fully busy for 10 seconds, SwarmCast turns off the most expensive quality, then the next one, until only your original quality is left. The panel and the Activity console tell you when that happens. Your stream on OBS is never affected.

## Smaller qualities save your upload

A viewer at 480p costs about a quarter of your upload compared with 1080p. When many people watch, the players move down by themselves, and your upload goes further. Viewers who help through [P2P](/swarmcast/live/p2p/) cost you even less.

## Change it yourself

In the **Quality for viewers** card you can:

- turn **Stream in multiple qualities** off or on;
- choose which qualities to offer;
- under **Advanced**, force one encoder.

Your choice is remembered and always wins over the automatic one.

## "The video converter (ffmpeg) is not installed"

The smaller qualities need ffmpeg, a free video converter. SwarmCast downloads it from its publisher the first time it opens and checks its fingerprint before use. If that failed (no internet at the time), click **Install the video converter** in the quality card. Without it, everything works with your original quality.
