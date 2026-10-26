#!/usr/bin/env node
// Direct mode on Windows (GitHub runners have no UPnP/NAT-PMP router):
//  1. the direct-mode unit tests (mock IGD, NAT-PMP, ACME) under Windows,
//  2. DirectMode + the mock UPnP gateway binding 0.0.0.0 for real (direct-igd.ts),
//  3. the installed app through the panel API with "manual port forward": HTTPS on a random
//     high port on 0.0.0.0 with a self-signed certificate, a viewer plays over it, back to the
//     secure mode closes the port; Windows Firewall state and rules are recorded.
//
// Usage: node scripts/test/windows/direct.mjs --work <dir from make-release.mjs> [--out results.json]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ART, appProcess, bug, check, copyAppLogs, environmentFacts, finish, info, joinAndPlay, killUnder, launchBrowser, listening, must, onCleanup, opt, ps, pushStream,
  quitAndVerify, record, repoRoot, section, serve, socketsOf, startApp, uninstallAndVerify, waitLiveLink, waitPhase,
} from './lib.mjs';

const work = path.resolve(opt('work', path.join(repoRoot, 'release', 'win-e2e')));
const relDir = path.join(work, 'rel');
const home = 'C:\\SC direct\\SwarmCast';

await section('0. environment', async () => {
  for (const [k, v] of Object.entries(environmentFacts())) info(k, v);
});

await section('1. direct-mode unit tests on Windows (vitest)', async () => {
  const files = ['apps/server/test/unit/direct.test.ts', 'apps/server/test/unit/acme.test.ts'].filter((f) => fs.existsSync(path.join(repoRoot, f)));
  const json = path.join(ART, 'direct-vitest.json');
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...files, '--reporter=default', '--reporter=json', `--outputFile.json=${json}`], { cwd: repoRoot, encoding: 'utf8', timeout: 600_000 });
  fs.writeFileSync(path.join(ART, 'direct-vitest.log'), `${r.stdout}\n${r.stderr}`);
  let summary = `exit ${r.status}`;
  try {
    const j = JSON.parse(fs.readFileSync(json, 'utf8'));
    summary = `${j.numPassedTests}/${j.numTotalTests} passed, ${j.numFailedTests} failed`;
    for (const t of j.testResults.flatMap((f) => f.assertionResults).filter((a) => a.status === 'failed')) record(`unit: ${t.fullName}`, 'fail', (t.failureMessages ?? []).join(' ').slice(0, 400));
  } catch {
    /* no JSON report */
  }
  check(`vitest ${files.map((f) => path.basename(f)).join(', ')}`, r.status === 0, summary);
});

await section('2. DirectMode + mock UPnP gateway, real 0.0.0.0 bind', async () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'scripts', 'test', 'windows', 'direct-igd.ts')], { cwd: repoRoot, encoding: 'utf8', timeout: 180_000 });
  const lines = (r.stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('{'));
  for (const l of lines) {
    const x = JSON.parse(l);
    if (x.knownBug) bug(x.name, x.ok, x.detail);
    else check(x.name, x.ok, x.detail);
  }
  must('direct-igd.ts produced results', lines.length > 0, `exit ${r.status}: ${(r.stderr ?? '').slice(0, 800)}`);
});

await section('3. app-level direct mode via the panel (manual port forward) + Windows Firewall', async () => {
  record('app-level test with the mock UPnP gateway', 'skip', 'the app has no way to point discovery at a test gateway: createApp() (apps/server/src/app.ts discoverMapper) always uses discoverUpnp() on 239.255.255.250:1900 and the OS default gateway for NAT-PMP, and lookupPublicIps() always asks 1.1.1.1. An env override (e.g. SWARMCAST_TEST_SSDP=host:port and SWARMCAST_TEST_PUBLIC_IP, test builds only) would allow it. Covered instead by section 2 (same DirectMode code) + this section (real app, manual forward).');
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
  const srv = await serve(relDir);
  onCleanup(() => srv.close());
  const browser = await launchBrowser('chrome');
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home, args: ['-Yes', '-SkipSpeedtest', '-NoTunnel'], label: 'direct' });
  onCleanup(() => killUnder(home));
  const s0 = await waitLiveLink(app);
  const feed = pushStream(s0.rtmpUrl, s0.streamKey);
  await waitPhase(app, 'live');

  const c = await app.api('/api/direct/check', {});
  info('direct check on an Azure VM (no router)', `ok=${c.ok} needsManualForward=${c.needsManualForward} code=${c.code}: ${c.message}`);
  check('check never opens anything and asks for a manual port forward (no UPnP/NAT-PMP here)', c.ok === true && c.needsManualForward === true, c.code);
  const refused = await app.api('/api/direct/enable', { acknowledgeRisks: true });
  check('enable without manualPortForward is refused', !refused.liveLink, refused.error ?? '');
  const en = await app.api('/api/direct/enable', { acknowledgeRisks: true, manualPortForward: true });
  must('direct mode on (manual forward)', typeof en.liveLink === 'string' && en.liveLink.startsWith('https://'), JSON.stringify(en).slice(0, 300));
  const u = new URL(en.liveLink);
  const port = Number(u.port);
  const st = await app.state();
  check('new link on the public IP and a random high port, self-signed certificate', port >= 20000 && port < 60000 && st.mode === 'direct' && st.direct.certificate === 'self-signed', `${u.hostname}:${port} cert=${st.direct.certificate}`);
  const main = appProcess(home);
  const socks = socketsOf([main.pid]);
  const any = socks.tcp.find((t) => t.LocalPort === port);
  check('SwarmCast listens on 0.0.0.0 for direct mode', any?.LocalAddress === '0.0.0.0', socks.tcp.map((t) => `${t.LocalAddress}:${t.LocalPort}`).join(' '));
  // Viewers open https://<public IP>:<port>: an IP literal, so the browser sends no SNI.
  const viaIp = en.liveLink.replace(`${u.hostname}:${port}`, `127.0.0.1:${port}`);
  const vIp = await joinAndPlay(browser, viaIp, 'direct-ip', { ignoreHTTPSErrors: true }).catch((e) => e);
  bug('a viewer plays over the direct link by IP address (https://<ip>:<port>, as sent to viewers)', !(vIp instanceof Error), vIp instanceof Error ? `${vIp.message.split('\n')[0]} -- the direct HTTPS server only has an SNICallback (apps/server/src/public/server.ts https options) and browsers send no SNI for IP addresses, so the TLS handshake fails` : '');
  if (!(vIp instanceof Error)) await vIp.context.close();
  const viaName = en.liveLink.replace(`${u.hostname}:${port}`, `localhost:${port}`);
  const v = await joinAndPlay(browser, viaName, 'direct-name', { ignoreHTTPSErrors: true }).catch((e) => e);
  check('the rest of direct mode works when SNI is sent (https://localhost:<port>): viewer plays', !(v instanceof Error), v instanceof Error ? v.message.split('\n')[0] : 'self-signed warning accepted');
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lan) {
    const r = await fetch(`https://${lan}:${port}/healthz`).catch((e) => e);
    info(`HTTPS on the LAN address ${lan}`, r instanceof Error ? `${r.message} (Node rejects the self-signed cert; the TCP connect itself is what matters)` : `HTTP ${r.status}`);
  }

  // Windows Firewall: what a streamer's PC would do with a new program listening on 0.0.0.0.
  const fw = ps(`(Get-NetFirewallProfile | ForEach-Object { "$($_.Name): enabled=$($_.Enabled) inbound=$($_.DefaultInboundAction) notifyOnListen=$($_.NotifyOnListen) allowLocalRules=$($_.AllowLocalFirewallRules)" }) -join '; '`, { allowFail: true });
  info('Windows Firewall profiles on the runner', fw);
  const exe = path.join(home, 'app', 'current', 'swarmcast.exe');
  const rules = ps(`$p = '${exe}'; @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -eq $p } | Get-NetFirewallRule | ForEach-Object { "$($_.DisplayName) $($_.Direction) $($_.Action) profile=$($_.Profile)" }) -join '; '`, { allowFail: true });
  info('firewall rules for swarmcast.exe after it listened on 0.0.0.0', rules || 'none (no prompt answered on the runner; on a PC with the firewall on, Windows shows "Windows Defender Firewall has blocked some features of this app" the first time and inbound stays blocked until the user clicks Allow; the listen itself succeeds and the app is not blocked)');

  if (!(v instanceof Error)) await v.context.close();
  const dis = await app.api('/api/direct/disable', {});
  const st2 = await app.state();
  check('back to the secure mode: new local link, direct port closed', st2.mode === 'secure' && typeof dis.liveLink === 'string' && !(await listening(port)), dis.liveLink?.replace(/\/join\/.*/, ''));
  const stop = await app.api('/api/live/stop', {});
  check('"Stop everything" verified after direct mode', stop.verified === true);
  feed.stop();
  await quitAndVerify(app, home, 'direct');
  copyAppLogs(home, 'direct');
});

await section('4. uninstall-windows.cmd while direct mode is on', async () => {
  const srv = await serve(relDir);
  onCleanup(() => srv.close());
  const app = await startApp({ entry: 'ps', dir: relDir, releaseUrl: srv.url, home, args: ['-Yes', '-SkipSpeedtest', '-NoTunnel'], label: 'direct-uninstall' });
  onCleanup(() => killUnder(home));
  await waitLiveLink(app);
  const en = await app.api('/api/direct/enable', { acknowledgeRisks: true, manualPortForward: true });
  must('direct mode on', typeof en.liveLink === 'string', JSON.stringify(en).slice(0, 200));
  const port = Number(new URL(en.liveLink).port);
  must('direct port listening', await listening(port));
  await uninstallAndVerify({ dir: relDir, home, label: 'uninstall with direct mode on', alsoPorts: [port] });
});

finish();
