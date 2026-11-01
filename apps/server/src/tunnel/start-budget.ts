/**
 * How long opening the secure tunnel may take when a live starts (the "Open the secure tunnel"
 * step), and the schedule inside it.
 *
 * No imports, on purpose: the system test harnesses (scripts/test/lib/app.mjs, which Node loads
 * with its built-in type stripping; scripts/test/docker/run.sh, which reads the number from this
 * file) wait for the live link as long as this step may take, and no longer. A harness that gave up
 * earlier would fail while SwarmCast was still recovering by design (a new tunnel over TCP, another
 * try after Cloudflare refused); one that waited longer would hide a step that ran past its limit.
 *
 * The step, in order (core/live.ts openTunnel):
 *  1. cloudflared asks Cloudflare for a new quick tunnel; a refusal or failure of that free service
 *     (429, 5xx, timeout) is tried again after START_RETRY_DELAYS_MS (tunnel/start-failure.ts),
 *     each cloudflared run having 45 s to print its address (tunnel/quick.ts);
 *  2. the new address must answer within REACHABLE_TIMEOUT_MS (DNS for a new name takes seconds);
 *  3. when it does not, or as soon as cloudflared reports that it cannot reach Cloudflare over UDP
 *     (QUIC), one new tunnel is opened over TCP (cloudflared --protocol http2) and steps 1 and 2
 *     run again.
 * TUNNEL_START_BUDGET_MS bounds all of it: when it runs out the step fails with err.tunnelTimeout,
 * and a retry that could not finish in time is not started (err.tunnelBusy says why at once).
 */

/** How long a new tunnel address may take to answer before SwarmCast opens another one. */
export const REACHABLE_TIMEOUT_MS = 60_000;

/**
 * The whole tunnel step's limit. Measured needs (CI runners, 2026-10/11): the UDP-blocked case
 * switches to TCP after about 10 to 20 s and the TCP tunnel answers 5 to 20 s later; three
 * refusals by Cloudflare cost at most 44 s of waits plus up to 15 s per refused request; a new
 * name that some resolver remembered as missing answers after up to 80 s. Four minutes covers the
 * UDP fallback plus three refusals plus a slow name, with room to spare, and is still short enough
 * for a streamer waiting in front of the panel.
 */
export const TUNNEL_START_BUDGET_MS = 240_000;
