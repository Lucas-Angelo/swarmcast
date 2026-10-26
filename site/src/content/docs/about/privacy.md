---
title: Privacy and usage numbers
description: SwarmCast has no telemetry. How the numbers on the home page are counted from GitHub's public download counters.
---

## SwarmCast does not phone home

- The app has **no telemetry, no analytics and no crash reports**. It never sends anything about you, your computer, your live or your viewers to the SwarmCast project.
- Your stream key, your links and your viewers' nicknames and IP addresses stay on your computer, in memory or in your settings folder.
- The viewer page has no ads, no trackers and no analytics.
- This website has **no trackers and no cookies**, and loads no fonts or scripts from other companies. It remembers your language and light/dark choice in your own browser (local storage) only.

What the app does contact, and why:

- **Cloudflare:** the free tunnel (Secure mode), the speed test, a quick check of your connection's delay while you are live, and, in Direct mode, finding your public IP address. Viewers' browsers also use a Cloudflare server to find each other for P2P.
- **GitHub:** looking for updates (a small public file) and downloading them.
- **The ffmpeg publisher:** downloading the video converter, the first time.
- **Public blocklists** (Spamhaus, FireHOL): downloaded once a day, without an account.
- **Let's Encrypt:** only in Direct mode, for the HTTPS certificate.

## How the numbers on the home page are counted

Without telemetry, we cannot know exactly how many people use SwarmCast. The home page shows two approximate numbers based only on **public counters that GitHub keeps for every file in a release**. Anyone can check them.

### Downloads

The sum of the download counters of the installers (Windows, macOS and Linux) and the script-install packages of every release. It also counts:

- the same person downloading twice;
- updates the app downloads by itself on Windows and Linux (AppImage).

So it is "about N downloads", not "N people".

### Apps opened this week

When the desktop app opens, and then every 6 hours while it stays open, it downloads a small public file from the latest release (`latest.json`) to look for updates. GitHub counts each of those downloads. Nothing else is sent.

Once a day, a GitHub job saves those counters (one per release, because each new release starts its own counter at zero) and computes:

1. **Update checks this week** = growth of the `latest.json` counters over the last 7 days, summed over all releases (when we have fewer than 7 days of history, the growth so far is scaled up to 7 days).
2. **Apps opened this week ≈ update checks ÷ 3.**

Why 3: one app makes **one check each time it opens**, plus one more every 6 hours it stays open. A streamer who opens SwarmCast for two or three lives a week, each shorter than 6 hours, makes about 3 checks a week. The real number of apps is somewhere between "checks ÷ 14" (an app left open all week) and "checks" (an app opened once). Clicking **Check for updates** also counts as a check.

The number is rounded **down** ("about 120" for anything from 120 to 129) and hidden until there is enough data.

The code that computes both numbers is public: [`scripts/stats/stats.mjs`](https://github.com/Lucas-Angelo/swarmcast/blob/main/scripts/stats/stats.mjs).
