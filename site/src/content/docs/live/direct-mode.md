---
title: Direct mode (emergencies only)
description: What Direct mode is, why it shows your IP address to viewers, and how to go back to Secure mode.
---

Normally SwarmCast uses **Secure mode**: viewers connect through an encrypted tunnel and never see your IP. The free tunnel has no uptime guarantee. If the live keeps stuttering for **everyone**, Direct mode is a last resort.

:::danger[Direct mode shows your IP address]
In Direct mode viewers connect **straight to your computer**, so **everyone with the link can see your internet IP address**. That reveals your approximate location and makes attacks possible that knock your internet offline (DDoS). Use it only with people you trust, and only when the tunnel keeps failing.
:::

## Turn it on

1. In the **Connection mode** card, click **Use Direct mode…**.
2. SwarmCast checks your router and your internet connection, and explains what it found. Some internet providers do not allow direct connections (CGNAT). Then Direct mode cannot work.
3. Read the warning, tick **I understand the risks** and click **Turn on Direct mode**.
4. Everyone is disconnected and you get a **new link**. Send it again.

On Windows, the first time, Windows may ask whether SwarmCast may use networks: click **Allow** (Private networks). Otherwise viewers cannot connect.

The panel shows a banner while Direct mode is on, and how many people saw the link in this mode.

## SwarmCast protects you while it is on

At the first signs of an attack, SwarmCast goes back to Secure mode by itself (with a new link). If that fails, it turns everything off. Both are on by default in the **Protection** card.

## Go back to Secure mode

Click **Back to Secure mode**. SwarmCast closes the router port, reopens the tunnel and makes a new link. Everyone is disconnected: send the new link again.

## Afterwards: getting a new IP

Your IP may stay the same after you leave Direct mode. To try to get a new one, unplug your modem or router for a few minutes. It is not guaranteed. The next time you use Direct mode, the panel tells you whether your IP changed.
