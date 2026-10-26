# Security research: DoS/DDoS, streamer IP and viewer IP protection

Research document; implementation status is marked with **✅ Implemented** below (see "Implemented: attack detection, reactions, proof-of-work, blocklists"). **Every source was checked on 2026-10-25.** Sources are cited as `[n]` and listed at the end with their URLs. "(unverified)" marks a claim we could not confirm at a primary source.

**Owner constraints:**
- Everything must be free.
- Options are ranked: **(A)** free with no account, then **(B)** free with one account created once by the developer, then **(C)** anything else.
- Paid options only appear in the last section.

---

## Resumo executivo (pt-BR)

- **Certificado Let's Encrypt não protege contra DDoS.** Ele só cifra a conexão e prova a identidade do servidor.
  - Pior: todo certificado emitido é publicado em logs públicos (Certificate Transparency) [5][6].
  - No Modo Direto isso publica o IP de casa da streamer, de novo a cada ~6 dias [4]. Qualquer pessoa pode consultar.
- **Captcha não protege contra DDoS de rede.** Uma inundação de tráfego derruba a internet de casa antes de qualquer página carregar [9][10].
  - Captcha ou prova de trabalho só ajudam contra abuso automatizado na aplicação, como enxurradas de entradas (joins).
- **O túnel rápido da Cloudflare continua sendo a melhor opção grátis e sem conta.** Ele esconde o IP da streamer, absorve DDoS e tem servidores no Brasil [11][14].
  - Risco a conhecer: os termos da Cloudflare restringem vídeo no plano grátis [12][13]. Ela pode bloquear o túnel.
- **Não existe outro túnel grátis e sem conta que aguente uma live com centenas de pessoas.**
  - Os que existem têm limite de velocidade, expiram em 60 minutos ou até vazam o IP da streamer (localtunnel, Tunnelmole) [16][17][19][20].
- **Alternativa grátis de verdade: uma máquina virtual "Always Free" da Oracle em São Paulo.** Ela dá 10 TB/mês e tem proteção anti-DDoS [29][32].
  - Exige conta Oracle com cartão de crédito e CPF [31], e alguma configuração técnica.
  - Recomendamos como opção avançada, não como padrão.
- **Modo Direto:** contra ataque volumétrico, nada no PC resolve; a conexão de casa simplesmente lota [8][9].
  - O que dá para fazer: usar o Modo Direto só como último recurso, deixar o túnel pronto como reserva e voltar para ele automaticamente se detectar ataque.
- **Espectadores com P2P ligado veem o IP uns dos outros.** Esconder o IP de verdade exige um servidor TURN (relay).
  - Não há TURN grátis e sem conta que funcione hoje [42].
  - No app, sem custo: pedir consentimento explícito antes de ligar o P2P e limitar quantos IPs cada pessoa consegue ver.
- **Ataques a espectadores são possíveis e baratos.** O Brasil é hoje a origem nº 1 de ataques DDoS [8]. Mesmo assim, o risco por live é baixo.
  - O efeito típico é a internet da vítima cair por alguns minutos: 90% dos ataques duram menos de 10 minutos [8].
- **Prioridade (P0):**
  - limite de sessões;
  - timeouts mais curtos;
  - proteção contra sobrecarga;
  - limitar quantos IPs cada pessoa vê pelo tracker;
  - consentimento do P2P;
  - aviso forte no Modo Direto.

---

## 1. Does a Let's Encrypt certificate help against DoS/DDoS?

**No.**

**What TLS does:** TLS gives server authentication, confidentiality and integrity [1]. Availability is not among its goals. Its only anti-DoS feature is the HelloRetryRequest cookie, which is aimed at datagram transports [1].

**TLS can make DoS worse:**
- A handshake costs the server an asymmetric-crypto operation per connection, so handshake floods are a known DoS vector ("SSL/TLS exhaustion", THC-SSL-DOS) [3].
- TLS 1.2 renegotiation costs the server a disproportionate amount of work. Node limits clients to 3 renegotiations per 10 minutes [2], and TLS 1.3 removed renegotiation [1][2].
- Node's default `handshakeTimeout` is 120 s [2], which is generous to slow-handshake attackers.

**The certificate also leaks the IP:**
- Let's Encrypt logs every certificate in public Certificate Transparency (CT) logs [5].
- IP certificates (generally available since 2026-01-15) are short-lived, 160 hours [4]. So Direct mode re-publishes the streamer's home IP about every 6 days, searchable on crt.sh [6].
- IP certificates can only be validated with http-01 (port 80) or tls-alpn-01 (port 443) [7]. Our ACME code maps port 80 for a few seconds during validation (`apps/server/src/direct/certs.ts`).

**What helps instead:** something in front of the IP that has more bandwidth than the attacker (Section 2), or simply not being reachable (Section 3).

**Does a captcha help?** Only against application-level or bot abuse such as join floods or scripted sessions. OWASP says puzzles "will not help defend against DoS attacks" [10]. Volumetric floods fill the link before any HTTP request is parsed [9].

## 2. Protecting the streamer without Direct mode (hide her IP)

Sizing for a big stream: 300 viewers × 3 Mbps × 2 h ≈ **810 GB at about 900 Mbps**. P2P reduces the origin's share.

| Rank | Option | Account (who) | Free limits that matter for video | WebSocket | Hides IP | DDoS absorption | Brazil PoP | Bundle/automate | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| A | **Cloudflare quick tunnel** (current default) | None | No byte cap published; **200 in-flight requests**, then 429; no SSE; no uptime guarantee; "testing and development" [11] | Yes [66] | Yes | Unmetered L3–L7 on all plans [14] (that quick tunnels get it is inferred) | Yes | `cloudflared` Apache-2.0, already bundled | **Keep as default.** ToS risk: free plans must use paid services for video [12]; the Tunnel FAQ applies this to public hostnames [13] |
| A | localhost.run (plain `ssh -R`) | None | "There is a speed limit" (number unpublished); domain changes "after a few hours" [16] | Unverified | Yes | Unknown | Unknown | No binary (system `ssh`) | Fallback candidate; **measure throughput first** |
| A | Pinggy free (plain `ssh`) | None | "Unlimited data", but **60-minute timeout and a new URL** [17] | Unverified | Yes | Unknown | Yes [17] | No binary | Only for short lives (or reconnect plus re-announce) |
| A | Serveo | None | Interstitial page on free; ToS says dev/testing/demos only [18] | Unverified | Yes | Unknown | Unknown | No binary | Not suitable |
| A | bore.pub | None | TCP only, **no TLS** [21] | n/a | Yes | Unknown | Unknown | MIT | Not suitable (no HTTPS) |
| A | localtunnel, Tunnelmole (hosted) | None | — | — | **No: leaks the IP.** The loca.lt password page uses the streamer's IP [19]; Tunnelmole puts the IP in the URL and X-Forwarded-For [20] | — | — | — | **Excluded** |
| B | **Oracle Always Free VM + frp, rathole or `ssh -R` + Caddy** | Oracle account (card + **CPF** for Brazil) [31]; the streamer's, or the developer's for a shared relay | **10 TB/month egress**; A1 VM 2 OCPU / 12 GB, about 1 Gbps per OCPU [29][30]; idle VMs reclaimed (p95 CPU, network and memory all under 20% for 7 days) [29] | Yes (Caddy) | Yes | L3/L4 managed by Oracle; capacity unpublished [32] | **São Paulo / Vinhedo** (home region only) [31] | frp and rathole Apache-2.0 [27]; `ssh` built in | **Best free, ToS-clean path.** Advanced/opt-in |
| B | Cloudflare named tunnel | Free account + a domain (not free) [26] | No 200 cap documented [26] | Yes | Yes | Same as quick tunnel | Yes | `cloudflared` | Same video ToS as quick tunnel [12][13]; needs a domain |
| B | zrok.io hosted (OpenZiti) | `zrok invite` | **5 GB/day** [24] | — | Yes | — | — | Apache-2.0 | Too small (self-hosted zrok has no limits but needs a VM) |
| B | Tailscale Funnel | Login | Non-configurable bandwidth limits; ports 443/8443/10000 only [23] | Undocumented | Yes | — | Unpublished | BSD-3 client | Too slow/limited |
| B | MS Dev Tunnels / ngrok free | Login | 5 GB/month [25] / **1 GB/month + interstitial page** [22] | Yes | Yes | — | Yes | Proprietary (ngrok forbids redistribution [22]) | Too small |
| B | Pangolin (self-hosted) | VM + domain | Like Oracle row | Yes | Yes | VM's | — | AGPL-3 core [28] | Heavier than frp; needs UDP |
| — | GCP / AWS / Render / Fly free tiers | Card | 1 GB/month (GCP) [33], 5 GB on Render, no free tier on Fly [34] | — | — | — | — | — | Not viable |

**Shared developer relay:**
- **Feasible:** one Oracle VM covers about 12 big streams a month across all users [29].
- **Drawbacks:** the developer becomes the operator of everyone's traffic. Caddy terminates TLS there, so the operator could read content. Capacity is also shared, with no SLA.
- **Preferred:** each streamer uses their own VM, configured by a guided script.
- **Never ship a third-party API token** inside the app. Anyone could extract it [40].

**HLS cache on the relay (optional):**
- nginx `proxy_cache` + `proxy_cache_lock` collapses identical segment requests, so the home PC uploads each segment about once [35].
- The cache must key on the URI only, while every request is still authorized with `auth_request` [35].

**Recommendation: add these tunnel providers.** Both fit `start(localPort) → https URL; stop()`.
1. **`ssh-relay` (P1).**
   - Spawns the system `ssh -R` with `ServerAliveInterval`, parses the URL from stdout, and restarts on exit. No bundled binary and no license issue.
   - Presets: localhost.run (no account), Pinggy (no account, 60-minute limit), and "my own server" (the streamer's VPS with Caddy).
   - **Measure real throughput before offering hosted presets.**
2. **`frp` (P2).** Bundles `frpc` (Apache-2.0) for a self-hosted relay. Comes with a documented Oracle Always Free recipe: Caddy, optional nginx HLS cache, frp `bandwidthLimit` per streamer [27].

**For any new provider:** decide how the client IP reaches us. Today `CF-Connecting-IP` is trusted only for `cloudflare-quick` (`apps/server/src/core/live.ts`). Otherwise every viewer shares one rate-limit IP bucket, the loopback address. Per-session keys still work, but the per-IP join limits don't.

## 3. If Direct mode is used anyway: honest limits

| Measure | Helps against | Does not help against | Source |
|---|---|---|---|
| Rate limits, short timeouts, `maxConnections` (already have) | App-level floods, slowloris | Volumetric floods: 96.6% of attacks are under 500 Mbps, yet that already saturates home links; "100 Mbps is enough" | [8][55] |
| SYN cookies | SYN floods against the OS (Linux default on; Windows always on) | Bandwidth saturation; macOS behavior undocumented | [52][53] |
| Random high port, one mapping, removed on stop (already have) | Opportunistic scanners | Anyone with the link; CT logs reveal the IP (not the port) | [5][6] |
| Change IP (reboot modem) | Ends an attack aimed at the old IP, if the plan is dynamic (not guaranteed; unverified for Vivo/Claro) | Static IPs, IPv6 prefixes (stable /56 or /64) | [49] |
| IPv6 temporary addresses (RFC 8981) | Address correlation over time | Floods to the /64 still hit the same link | [65] |
| ISP mitigation | Brazilian ISPs typically blackhole the target (RTBH), which keeps the streamer offline anyway | — | [49] |
| **Hot-standby tunnel + auto-revert** | Restores the live within seconds | Doesn't stop the attack on the home IP | design |

**Recommendations for Direct mode:**
- **Last resort only.** The UI must say that the home IP is published in public CT logs and stays known after the live [5][6].
- **Hot standby:**
  - Start the quick tunnel in parallel and put its URL in `/api/config` as `fallbackUrl`.
  - The viewer switches to it after N consecutive failures. Cookies are per-host, so the viewer gets a one-time re-join ticket (P1).
- **✅ Implemented: attack detection + automatic revert** (without the hot standby: the tunnel is opened when reverting; if that fails, Stop everything). Signals used:
  - spikes in `net.Server` `'drop'` events (emitted when over `maxConnections` [55]) (✅, counted with our own 429s);
  - the TLS handshake error rate (✅);
  - the gateway RTT probe jumps (not implemented);
  - the upload limiter is saturated while viewers stall (✅, as a corroborating signal);
  - also: requests/s, join attempts and refused joins/s, WebSocket upgrades/s, open connections, distinct client IPs (✅).
- **TLS hardening:** set `handshakeTimeout: 10_000` (**✅ implemented**), prefer `minVersion: 'TLSv1.3'` (iOS 17.1+ supports it), and keep ECDSA P-256 keys [2].
- **UPnP:** keep the lease short and the mapping single (CERT advises against UPnP on internet-facing interfaces [54]).

## 4. Protecting P2P viewers' IPs

**Facts:**
- STUN always exposes the public IP: the server-reflexive candidate.
- mDNS host candidates hide only LAN addresses [38]. RFC 8828's default modes still use the public default route [37].
- Only `iceTransportPolicy: 'relay'` stops the remote peer from learning the IP [39]. It protects only the viewer whose own client sets it.
- p2p-media-loader v4 passes `core.rtcConfig` straight to `RTCPeerConnection`. So TURN `iceServers` + `iceTransportPolicy` work, and `rtcConfig` can be changed via `applyDynamicConfig`, for new connections only [36].
- **Relaying moves bandwidth; it does not remove it.** Each relayed byte goes A → TURN → B. Example: 200 viewers × 3 Mbps × 2 h = 540 GB; at 60% P2P, **324 GB per stream** goes through TURN (2.6 TB/month at 8 streams). The streamer's upload is still offloaded; the TURN operator pays.

**TURN options:**

| Rank | TURN option | Account (who) | Free limit | Fits 324 GB/stream? | Notes |
|---|---|---|---|---|---|
| A | Metered "Open Relay" (static public credentials) | None | — | — | Did not respond in our test on 2026-10-25; old host resolves to 192.0.2.1; "can and will go down without notice" [42]. **Unusable** |
| A | TURN on the streamer's PC | None | — | — | Exposes her IP and doubles her upload: **No** |
| B | **coturn on Oracle Always Free** (BSD-3) | Oracle (card + CPF) | 10 TB/month [29][45] | Yes (all 8 streams) | Needs a small credential service (coturn shared-secret, short-lived) |
| B | Cloudflare Realtime TURN | Developer account (card unverified) | 1,000 GB/month, then $0.05/GB [40] | About 3 streams/month | API key must stay server-side [40]; ToS frames use as "video call functionality" [41] (grey area) |
| B | ExpressTURN free | Developer account | 1,000 GB/month; free plan has no shared-secret auth, so static credentials are exposed [43] | About 3 streams/month | Can terminate without notice [43] |
| B | Metered / Xirsys free | Developer account | 20 GB (Open Relay w/ account) / 500 MB [42][44] | No | — |

**In-app options with no TURN** (each is free and needs no account):

| Option | Privacy gain | Bandwidth cost | Effort |
|---|---|---|---|
| **Explicit P2P consent on first visit** ("Help with P2P: other viewers can see your IP" / "Watch only") instead of silent default-on; PeerTube documents the same exposure and lets users disable it [51] | Informed choice | Lower P2P share | S |
| **Tracker disclosure cap:** each session learns at most N (e.g. 20) distinct peers per live; it stops a malicious member harvesting every IP by re-announcing | Bounds harvesting | Minimal | S–M |
| Same-public-IP-only P2P (household, campus, carrier CGNAT): peers already share that IP | Zero new exposure | Small offload | S |
| Lower `p2pMaxPeers` | Fewer peers see you | Slightly less P2P | XS |
| Optional "Hide my IP (relay)" toggle, only if the streamer configured TURN (config `turnServers`) | Full, for those who choose it | Moves those bytes to TURN | M |

**Likelihood and impact:**
- Booters cost "a few dollars to several hundred per month" [47]. Despite repeated takedowns (Operation PowerOFF) [48], they keep coming back.
- Brazil was the #1 DDoS source in H1 2026 (14.9%) [8]. Brazilian regional ISPs are heavily targeted [49].
- 90.6% of attacks end within 10 minutes [8]. So a targeted viewer typically loses connectivity for minutes, and the ISP may blackhole their IP longer.
- A viewer behind CGNAT (common on mobile) exposes a carrier IP; attacking it hits the carrier gateway.
- More than 50% of Brazilian traffic is IPv6 [50], and those addresses point at one household.
- **Assessment:** low probability per stream, but real for a motivated member with a grudge, so consent plus a harvesting cap are proportionate.

## 5. Application-level DoS hardening (origin behind a tunnel)

**Key property:** every authenticated route requires the 256-bit link secret and the tunnel hostname. So **app-level floods can only come from someone who has the link** (a member or leaker), plus generic hits on `/healthz` and 404 pages.

**Do not request our own certificate for the trycloudflare hostname.** Quick tunnels use a wildcard certificate, so the hostname is not in CT; a per-name ACME certificate would publish it.

| Gap / control | Status | Recommendation | Source |
|---|---|---|---|
| Total sessions | **No cap** | `maxSessions` (default e.g. 500); `/api/join` returns 503 when full; at most 1–2 live sessions per device cookie | [10] |
| Join rate | 10/min/IP on `/api/join`, 20/min on `/join/:secret` | Add `ban` after repeated 429s; per-IP keys need a trusted client IP for every provider (Section 2) | [56] |
| Slow requests | Fastify timeouts set | Also Node `headersTimeout` 5–10 s, `maxRequestsPerSocket` 100, `maxHeaderSize` 8 KiB (Node/Fastify docs warn to set timeouts when no proxy is in front) | [55][56] |
| Overload | — | `@fastify/under-pressure` (MIT): 503 when event-loop delay is over ~1 s or heap is over ~75% | [57] |
| WebSocket | `maxPayload` 64 KB/4 KB, 60 and 30 msgs/10 s, deflate off | Good (`ws` default is 100 MiB, so keep it explicit) | [58] |
| Tunnel concurrency | 200 in-flight (warning exists) | P2P keeps HTTP load down; keep `errorRetry` backoff on 429 | [11] |
| Join challenge | **✅ Implemented** (ALTCHA protocol, see below) | **ALTCHA** (MIT): `/dist/external` build ≈ 31 KB gzipped plus a 2 KB worker served from `'self'`; works with `script-src 'self'; style-src 'self'; worker-src 'self'` (SHA/PBKDF2 only); server `altcha-lib` (MIT) | [59] |
| Panic: rotate under attack | Manual "Generate new link" | One click: new secret + new quick-tunnel hostname; current sessions get a one-time re-join ticket via `/control`; the attacker's target vanishes | design |
| Members-only edge gate | — | Spike only: "Protected Quick Tunnels" (`--allowed-mail`, Oct 2026) puts an email one-time PIN at Cloudflare's edge, so floods never reach the PC. But it needs member emails and sessions end after **4 h** | [15] |

**Rejected join challenges:**
- **Cap (Apache-2.0):** fetches WASM from jsdelivr by default, needs `'wasm-unsafe-eval'` and inline styles [60].
- **mCaptcha:** AGPL server + Postgres, pre-alpha [61].
- **Turnstile:** requires a Cloudflare account [62].

**ALTCHA:** turn it on only when "under attack" (or above N joins/min). PoW raises the cost per join; it doesn't stop GPU or botnet attackers [63], and it costs battery on phones.

## 6. Implementation plan

Effort: XS < 2 h, S ≈ 0.5 d, M ≈ 1–2 d, L ≈ 3–5 d.

| Pri | Item | Effort | Files |
|---|---|---|---|
| P0 | Session cap + per-device session limit + 503 when full | S | `apps/server/src/access/access.ts`, `public/server.ts`, `core/config.ts`, `packages/shared/src/i18n` |
| P0 | Timeouts: `headersTimeout`, `maxRequestsPerSocket`, `maxHeaderSize`; TLS `handshakeTimeout` 10 s + TLS 1.3 in direct mode | S | `apps/server/src/public/server.ts`, `core/live.ts` |
| P0 | `@fastify/under-pressure` | XS | `apps/server/src/public/server.ts`, `apps/server/package.json` |
| P0 | Tracker disclosure cap (max distinct peers per session per live) | S–M | `apps/server/src/tracker/tracker.ts` |
| P0 | P2P explicit consent on first visit (keep the remembered choice) | S | `apps/viewer/src/watch.ts`, `watch.html`, `apps/viewer/src/i18n.ts`, shared i18n |
| P0 | Direct-mode warning: IP published in CT logs, last resort; update threat model | XS | admin panel strings, `docs/THREAT_MODEL.md`, `README.md` |
| P1 | Panic rotate (new secret + new tunnel host + re-join tickets over `/control`) | M | `core/live.ts`, `control/control.ts`, `access/access.ts`, `tunnel/quick.ts`, `apps/viewer/src/watch.ts` |
| P1 | Direct mode hot-standby tunnel, `fallbackUrl`, attack detection + auto-revert (**✅ detection + auto-revert done**; hot standby/`fallbackUrl` still open) | M–L | `direct/direct.ts`, `core/live.ts`, `packages/shared/src/schemas.ts`, `apps/viewer/src/watch.ts` |
| P1 | `ssh-relay` tunnel provider (localhost.run / Pinggy / own server) + client-IP trust per provider; throughput test first | M | `tunnel/ssh.ts` (new), `tunnel/parse.ts`, `core/config.ts`, `public/security.ts`, `core/live.ts` |
| P1 | ALTCHA on `/api/join` (self-hosted worker, auto-enabled under attack) (**✅ done**) | M | `apps/viewer/src/join.ts`, `join.html`, `public/server.ts`, `public/security.ts` (CSP unchanged) |
| P2 | `frp` provider + Oracle Always Free relay guide (Caddy, nginx HLS cache with `auth_request`) | L | `tunnel/frp.ts` (new), `scripts/build/versions.json`, new docs |
| P2 | Optional TURN: `turnServers` config + viewer "hide my IP (relay)" toggle (`iceTransportPolicy: 'relay'`) | M | `core/config.ts`, `public/server.ts` (`/api/config`), `apps/viewer/src/watch.ts` |
| P2 | Same-public-IP-only P2P mode | S | `tracker/tracker.ts` |
| P2 | Spike: Protected Quick Tunnels (`--allowed-mail`) | S | `tunnel/quick.ts` |

## Implemented: attack detection, reactions, proof-of-work, blocklists

Code: `apps/server/src/security/` (detector, reactions, pow, blocklists, cidr, shield). Panel: **Protection** card (EN/pt-BR tooltips). Defaults and why:

| Control | Default | Why |
|---|---|---|
| Attack detector | always on | Pure logic, rolling 10 s window; thresholds = max(absolute floor, k × EWMA baseline learned while calm, per-viewer allowance), so a 400-viewer stream or a raid of real joins does not trigger. normal → suspicious → attack after 3 s; attack → suspicious after 60 s calm, → normal after 120 s more; exit thresholds are 60 % of entry ones |
| Light browser check when suspicious, strong under attack | on | Invisible to viewers ("Checking your browser…", solved while they type), ≤ 20,000 SHA-256 attempts ≈ 0.1–0.2 s on a laptop, around a second on a mid-range phone |
| Tighten under attack | on | Join limits ÷ 4 per IP, 1 session per browser, viewer cap held at max(20, 1.25 × sessions + 10); nobody watching is dropped |
| Auto new link (Secure mode) | **off** | The streamer must resend it; when it happens the panel highlights the new link and explains |
| Direct mode → back to Secure mode | on | Nothing on the PC stops a flood on the home IP [8][9] |
| …and Stop everything if that fails | on | Same reason |
| Stop everything on any attack | **off** | In Secure mode Cloudflare absorbs volumetric floods [14]; only app-level abuse reaches the PC |
| Always require the browser check | **off** | Costs battery for no reason when nothing is happening |
| Public blocklists | on | Conservative lists, rare false positives; bogons/CGNAT/private ranges are never blocked |

**ALTCHA evaluation (2026-10-25):** `altcha@3.5.0` (widget) and `altcha-lib@2.8.0` (server), both MIT [59]. The widget's external build has no `eval`/`new Function` and no `style=` attributes (it only uses the CSSOM, which `style-src 'self'` allows), so it would run under our CSP. We still use only `altcha-lib` (`^2.8.0`) on both sides: its `solveChallenge` + WebCrypto SHA-256 run in our own Vite-built same-origin worker (3 KB) instead of the 85 KB Svelte widget, so the check is invisible, translated by our dictionaries, and needs no third-party UI. Challenges are HMAC-signed (deterministic counter + key signature, so verifying is two HMACs), expire after 10 minutes, are single use (replay store, fails closed when full) and use a per-live secret.

**Public blocklists (checked 2026-10-25, all free and with no account; only a plain GET is sent):**

| List | URL | Format | Terms |
|---|---|---|---|
| Spamhaus DROP (IPv4) | https://www.spamhaus.org/drop/drop_v4.json | JSON lines (`{"cidr":…}` + metadata line); ~1,700 networks | Free of charge under https://www.spamhaus.org/drop/terms/ (no account; do not use the Spamhaus name in marketing) |
| Spamhaus DROPv6 | https://www.spamhaus.org/drop/drop_v6.json | JSON lines; ~90 networks | Same |
| FireHOL level1 | https://iplists.firehol.org/files/firehol_level1.netset | Netset (one CIDR per line, `#` comments); ~4,600 entries: Spamhaus DROP, DShield top attackers, Feodo, full bogons | "Maximum protection with minimum false positives"; lists remain property of their maintainers (iplists.firehol.org). Its bogons include 10/8, 100.64/10, 127/8, 192.168/16, so private/CGNAT/loopback ranges are excluded in code |
| abuse.ch Feodo Tracker (optional, `"feodo"`) | https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.txt | One IP per line | CC0, commercial use allowed (https://abuse.ch/terms-of-use/ §3.4); already included in FireHOL level1, so off by default |

Downloaded at app start and re-checked hourly (refreshed when older than 24 h), cached with the fetch date in `<data dir>/blocklists/`, the cache is used offline, and a failed or empty download never replaces a good copy. Entries wider than /8 (IPv4) or /12 (IPv6) are ignored. Aggressive lists (full blocklist.de, Tor exit nodes) are only possible via `security.extraBlocklistUrls`.

## 7. If budget appears later (one line each)

- **VPS in São Paulo with DDoS protection included:**
  - Akamai/Linode: about $5/month, 1 TB, then $0.007/GB [64].
  - Vultr São Paulo: DDoS protection +$10/month [64].
  - OVH has the strongest anti-DDoS but no Brazil region [64].
- **TURN:**
  - ExpressTURN Premium: $9/month for 5 TB [43].
  - Cloudflare Realtime TURN: $0.05/GB [40].
  - Twilio São Paulo: $0.80/GB [46].
- **Cloudflare video-compliant path:** use Stream/R2 instead of serving video through the tunnel [12].

## Sources (all checked 2026-10-25)

1. RFC 8446, TLS 1.3 (§1, §4.2.2) — https://www.rfc-editor.org/rfc/rfc8446.html — checked 2026-10-25
2. Node.js TLS docs (renegotiation limits, handshakeTimeout) — https://nodejs.org/api/tls.html — checked 2026-10-25
3. NETSCOUT, SSL/TLS exhaustion — https://www.netscout.com/what-is-ddos/ssl-tls-exhaustion — checked 2026-10-25
4. Let's Encrypt, short-lived and IP certificates GA — https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability — checked 2026-10-25
5. Let's Encrypt, CT logs — https://letsencrypt.org/docs/ct-logs/ — checked 2026-10-25
6. crt.sh, first Let's Encrypt IP certificate (IP in SAN) — https://crt.sh/?id=19376952215 — checked 2026-10-25
7. Let's Encrypt, challenge types — https://letsencrypt.org/docs/challenge-types/ — checked 2026-10-25
8. Cloudflare DDoS threat report H1 2026 — https://blog.cloudflare.com/ddos-threat-report-2026-h1/ — checked 2026-10-25
9. Cloudflare Learning, what is a DDoS attack — https://www.cloudflare.com/learning/ddos/what-is-a-ddos-attack/ — checked 2026-10-25
10. OWASP Denial of Service Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html — checked 2026-10-25
11. Cloudflare Quick Tunnels — https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/ — checked 2026-10-25
12. Cloudflare Service-Specific Terms (CDN, video) — https://www.cloudflare.com/service-specific-terms-application-services/ — checked 2026-10-25
13. Cloudflare Tunnel FAQ (video on public hostnames) — https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/ — checked 2026-10-25
14. Cloudflare DDoS protection (unmetered, all plans) — https://developers.cloudflare.com/ddos-protection/ — checked 2026-10-25
15. Cloudflare blog, Protected Quick Tunnels — https://blog.cloudflare.com/protected-quick-tunnels/ — checked 2026-10-25
16. localhost.run docs / forever-free — https://localhost.run/docs/ , https://localhost.run/docs/forever-free/ — checked 2026-10-25
17. Pinggy (free limits, Brazil server) — https://pinggy.io/ , https://pinggy.io/docs/ — checked 2026-10-25
18. Serveo and terms — https://serveo.net/ , http://serveo.net/terms/ — checked 2026-10-25
19. localtunnel issue #719 (tunnel password page) — https://github.com/localtunnel/localtunnel/issues/719 — checked 2026-10-25
20. Tunnelmole client (IP in URL/X-Forwarded-For) — https://github.com/robbie-cahill/tunnelmole-client — checked 2026-10-25
21. bore — https://github.com/ekzhang/bore — checked 2026-10-25
22. ngrok free plan limits / ToS — https://ngrok.com/docs/pricing-limits/free-plan-limits/ , https://ngrok.com/tos — checked 2026-10-25
23. Tailscale Funnel — https://tailscale.com/kb/1223/funnel — checked 2026-10-25
24. zrok pricing / repo — https://zrok.io/pricing/ , https://github.com/openziti/zrok — checked 2026-10-25
25. Microsoft Dev Tunnels limits — https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits#dev-tunnels-limits — checked 2026-10-25
26. Cloudflare account limits (tunnels) — https://developers.cloudflare.com/cloudflare-one/account-limits/ — checked 2026-10-25
27. frp / rathole — https://github.com/fatedier/frp , https://github.com/rathole-org/rathole — checked 2026-10-25
28. Pangolin — https://github.com/fosrl/pangolin , https://docs.pangolin.net/self-host/quick-install — checked 2026-10-25
29. Oracle Always Free resources (10 TB, A1 2 OCPU/12 GB, idle reclamation) — https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm — checked 2026-10-25
30. Oracle compute shapes (1 Gbps per OCPU) — https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm — checked 2026-10-25
31. Oracle sign-up (card, CPF, home region) — https://docs.oracle.com/en-us/iaas/Content/GSG/Tasks/signingup_topic-Sign_Up_for_Free_Oracle_Cloud_Promotion.htm — checked 2026-10-25
32. Oracle DDoS protection — https://docs.oracle.com/en/solutions/learn-ddos-prevention-oci/understand-ddos-layers-and-oracle-ddos-protection1.html — checked 2026-10-25
33. Google Cloud free tier — https://docs.cloud.google.com/free/docs/free-cloud-features — checked 2026-10-25
34. Render outbound bandwidth / Fly.io pricing — https://render.com/docs/outbound-bandwidth , https://docs.fly.io/about/pricing — checked 2026-10-25
35. HLS caching (Unified Streaming) / nginx auth_request — https://docs.unified-streaming.com/best-practice/caching/recommendations/configuration/decrease-upstream-traffic.html , https://nginx.org/en/docs/http/ngx_http_auth_request_module.html — checked 2026-10-25
36. p2p-media-loader core types (rtcConfig, dynamic config) — https://github.com/Novage/p2p-media-loader/blob/main/packages/p2p-media-loader-core/src/types.ts — checked 2026-10-25
37. RFC 8828, WebRTC IP address handling — https://www.rfc-editor.org/rfc/rfc8828.html — checked 2026-10-25
38. mDNS ICE candidates draft — https://datatracker.ietf.org/doc/draft-ietf-mmusic-mdns-ice-candidates/ — checked 2026-10-25
39. W3C WebRTC (iceTransportPolicy "relay") — https://www.w3.org/TR/webrtc/ — checked 2026-10-25
40. Cloudflare Realtime pricing / TURN credentials — https://developers.cloudflare.com/realtime/pricing/ , https://developers.cloudflare.com/realtime/turn/generate-credentials/ — checked 2026-10-25
41. Cloudflare Developer Platform terms (Realtime) — https://www.cloudflare.com/service-specific-terms-developer-platform/ — checked 2026-10-25
42. Metered Open Relay / terms — https://www.metered.ca/tools/openrelay/ , https://www.metered.ca/tools/openrelay/terms-and-conditions — checked 2026-10-25 (live test failed)
43. ExpressTURN / terms — https://www.expressturn.com/ , https://www.expressturn.com/terms — checked 2026-10-25
44. Xirsys pricing — https://xirsys.com/pricing/ — checked 2026-10-25
45. coturn license (BSD-3) — https://github.com/coturn/coturn/blob/master/LICENSE — checked 2026-10-25
46. Twilio STUN/TURN pricing — https://www.twilio.com/en-us/stun-turn/pricing — checked 2026-10-25
47. KrebsOnSecurity, booter takedown — https://krebsonsecurity.com/2022/12/six-charged-in-mass-takedown-of-ddos-for-hire-sites/ — checked 2026-10-25
48. Europol Operation PowerOFF — https://www.europol.europa.eu/how-we-work/operations/operation-poweroff — checked 2026-10-25
49. Security Boulevard (A10), attacks on Brazilian regional ISPs, RTBH — https://securityboulevard.com/2026/03/attackers-hit-brazils-regional-isps-telcos-the-1-ddos-target-globally/ — checked 2026-10-25
50. Internet Society Pulse, IPv6 in Brazil above 50% — https://pulse.internetsociety.org/en/news/the-silent-revolution-of-ipv6-in-brazil-50-adoption-milestone-achieved/ — checked 2026-10-25
51. PeerTube privacy guide — https://docs.joinpeertube.org/admin/privacy-guide — checked 2026-10-25
52. Linux ip-sysctl (tcp_syncookies default 1) — https://docs.kernel.org/networking/ip-sysctl.html — checked 2026-10-25
53. Microsoft, SYN attack protection on by default since Vista — https://learn.microsoft.com/en-us/archive/blogs/netro/tcpip-stack-hardening-in-operating-systems-starting-with-windows-vista — checked 2026-10-25
54. CERT VU#339275 (UPnP CallStranger) — https://kb.cert.org/vuls/id/339275 — checked 2026-10-25
55. Node.js http / net docs (timeouts, maxConnections 'drop') — https://nodejs.org/api/http.html , https://nodejs.org/api/net.html — checked 2026-10-25
56. Fastify server options / @fastify/rate-limit — https://fastify.dev/docs/latest/Reference/Server/ , https://github.com/fastify/fastify-rate-limit — checked 2026-10-25
57. @fastify/under-pressure — https://github.com/fastify/under-pressure — checked 2026-10-25
58. ws docs (maxPayload default 100 MiB) — https://github.com/websockets/ws/blob/master/doc/ws.md — checked 2026-10-25
59. ALTCHA widget / altcha-lib (MIT; sizes measured from npm altcha@3.5.0) — https://github.com/altcha-org/altcha , https://github.com/altcha-org/altcha-lib — checked 2026-10-25
60. Cap — https://github.com/tiagozip/cap — checked 2026-10-25
61. mCaptcha — https://github.com/mCaptcha/mCaptcha — checked 2026-10-25
62. Cloudflare Turnstile get started — https://developers.cloudflare.com/turnstile/get-started/ — checked 2026-10-25
63. Laurie & Clayton, "Proof-of-Work Proves Not to Work" — https://www.cl.cam.ac.uk/~rnc1/proofwork.pdf — checked 2026-10-25
64. Akamai São Paulo pricing / Vultr DDoS cost / OVH anti-DDoS — https://www.akamai.com/cloud/pricing/sao-paulo , https://docs.vultr.com/support/platform/billing/how-much-does-ddos-protection-cost , https://www.ovhcloud.com/en/security/anti-ddos/ — checked 2026-10-25
65. RFC 8981, IPv6 temporary addresses — https://www.rfc-editor.org/rfc/rfc8981.html — checked 2026-10-25
66. Cloudflare WebSockets — https://developers.cloudflare.com/network/websockets/ — checked 2026-10-25
