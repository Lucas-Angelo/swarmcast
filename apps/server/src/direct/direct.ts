import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { CodedText, DirectModeState, MessageKey, MessageParams } from '@swarmcast/shared';
import { translate } from '@swarmcast/shared/i18n';
import { CodedError, coded } from '../core/messages.js';
import { canBindPort } from '../core/ports.js';
import type { Logger } from '../core/logger.js';
import type { StateStore } from '../core/state.js';
import type { CertificateIssuer, IssuedCert } from './certs.js';
import { isNonPublicIPv4, type PortMapper } from './mapper.js';
import type { PublicIps } from './publicip.js';

export interface DirectServerHandle {
  close(): Promise<void>;
}

export interface DirectDeps {
  log: Logger;
  state: StateStore;
  discoverMapper: () => Promise<PortMapper | null>;
  /** Rebuild a mapper from the identifier saved before a crash. */
  mapperFromId: (kind: 'upnp' | 'natpmp', id: string) => PortMapper | null;
  publicIps: () => Promise<PublicIps>;
  localAddress: () => Promise<string>;
  /** Addresses assigned to local interfaces (to see whether a public IPv6 is ours). */
  localAddresses: () => string[];
  issuer: CertificateIssuer;
  /** Start the public HTTPS server on 0.0.0.0/:: <port> using the given TLS context provider. */
  startServer: (
    port: number,
    host: string,
    sni: (name: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void,
    /** Served when the client sends no SNI — always the case for https://<IP>. */
    defaultCert: { key: string; cert: string },
  ) => Promise<DirectServerHandle>;
  /** TCP reachability probe used to confirm the port is closed afterwards. */
  probe?: (host: string, port: number) => Promise<boolean>;
  random?: () => number;
  /** Can the public server listen on host:port? (tests; default: a real bind, see ports.ts) */
  canBind?: (port: number, host: string) => Promise<boolean>;
}

/** Random ports tried before giving up (Windows can reserve large blocks of high ports). */
const PORT_TRIES = 25;

/** `message` is English; `code`/`params` let the panel translate it. */
type Coded = { message: string; code: MessageKey; params?: MessageParams };
export type CheckResult =
  | ({ ok: true; publicIp: string; family: 4 | 6; mapper: PortMapper | null; needsManualForward: boolean } & Coded)
  | ({ ok: false; reason: 'cgnat' | 'no-internet'; publicIp?: string } & Coded);

function msg(code: MessageKey): Coded {
  return { code, message: translate('en', code) };
}

export const CGNAT_MESSAGE = translate('en', 'direct.check.cgnat');

export const MANUAL_FORWARD_MESSAGE = translate('en', 'direct.check.manual');

/**
 * Direct mode: viewers connect to the streamer's public IP instead of the tunnel.
 * Never turns itself on — only enable() (an explicit, confirmed action) does.
 */
export class DirectMode {
  active = false;
  publicIp?: string;
  externalPort?: number;
  private internalPort?: number;
  private mapper: PortMapper | null = null;
  private cert: IssuedCert | null = null;
  private ctx: tls.SecureContext | null = null;
  private server: DirectServerHandle | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  viewersSeen = new Set<string>();
  ipChanged: boolean | null = null;
  staleMapping = false;

  constructor(private readonly d: DirectDeps) {}

  /** On app start: compare the current IP with the one exposed last time; detect leftovers of a crash. */
  async init(): Promise<void> {
    const st = this.d.state.load();
    this.staleMapping = !!st.activeMapping;
    if (st.lastDirectIp) {
      const ips = await this.d.publicIps().catch(() => ({}) as PublicIps);
      const current = st.lastDirectIp.includes(':') ? ips.v6 : ips.v4;
      this.ipChanged = current ? current !== st.lastDirectIp : null;
    }
  }

  /** Remove a mapping left open by a crash, using the identifier saved on disk. */
  async cleanupStale(): Promise<boolean> {
    const st = this.d.state.load();
    const m = st.activeMapping;
    if (!m) {
      this.staleMapping = false;
      return true;
    }
    const mapper = this.d.mapperFromId(m.kind, m.id) ?? (await this.d.discoverMapper());
    if (!mapper) return false;
    await mapper.unmap(m.externalPort, m.internalPort);
    const still = await mapper.hasMapping(m.externalPort).catch(() => false);
    if (still) return false;
    this.d.state.save({ ...st, activeMapping: null });
    this.staleMapping = false;
    return true;
  }

  /** CGNAT detection and router capability check. Never changes anything. */
  async check(): Promise<CheckResult> {
    const [ips, mapper] = await Promise.all([this.d.publicIps(), this.d.discoverMapper().catch(() => null)]);
    const v6Local = ips.v6 && this.d.localAddresses().includes(ips.v6) ? ips.v6 : undefined;
    if (!ips.v4 && !v6Local) return { ok: false, reason: 'no-internet', ...msg('direct.check.noInternet') };

    if (ips.v4 && mapper) {
      const routerIp = await mapper.externalIp().catch(() => undefined);
      if (routerIp && routerIp === ips.v4 && !isNonPublicIPv4(routerIp)) {
        return { ok: true, publicIp: ips.v4, family: 4, mapper, needsManualForward: false, ...msg('direct.check.routerOk') };
      }
      if (v6Local) {
        return {
          ok: true,
          publicIp: v6Local,
          family: 6,
          mapper: null,
          needsManualForward: false,
          ...msg('direct.check.v6Cgnat'),
        };
      }
      return { ok: false, reason: 'cgnat', ...msg('direct.check.cgnat'), publicIp: ips.v4 };
    }
    if (v6Local && !ips.v4) {
      return { ok: true, publicIp: v6Local, family: 6, mapper: null, needsManualForward: false, ...msg('direct.check.v6Only') };
    }
    // Router did not answer: we cannot rule out CGNAT.
    return {
      ok: true,
      publicIp: ips.v4!,
      family: 4,
      mapper: null,
      needsManualForward: true,
      ...msg('direct.check.manualCgnat'),
    };
  }

  pickPort(): number {
    const r = this.d.random ?? Math.random;
    return 20000 + Math.floor(r() * 40000);
  }

  /**
   * A random high port the public server can really listen on. Checked before anything is
   * mapped on the router: Windows reserves whole ranges of high ports (Hyper-V, WinNAT) where
   * listening fails with EACCES, and another program may already use the port.
   */
  async pickBindablePort(host: string): Promise<number> {
    const canBind = this.d.canBind ?? canBindPort;
    const tried: number[] = [];
    for (let i = 0; i < PORT_TRIES; i++) {
      const port = this.pickPort();
      if (tried.includes(port)) continue;
      tried.push(port);
      if (await canBind(port, host)) return port;
    }
    this.d.log.warn({ tried }, 'direct mode: no port could be opened');
    throw new CodedError('err.directNoPort');
  }

  /**
   * Turn direct mode on. Opens exactly one random high external port pointing to the
   * public SwarmCast server (never 1935 or the admin port). Returns the base URL.
   */
  async enable(opts: { manualPortForward?: boolean } = {}): Promise<string> {
    if (this.active) throw new CodedError('err.directAlreadyOn');
    const check = await this.check();
    if (!check.ok) throw new CodedError(check.code, check.params);
    if (check.needsManualForward && !opts.manualPortForward) throw new CodedError(check.code, check.params);

    const externalPort = await this.pickBindablePort(check.family === 4 ? '0.0.0.0' : '::');
    const internalPort = externalPort;
    const localHost = check.family === 4 ? await this.d.localAddress() : '::';
    try {
      if (check.mapper) {
        await check.mapper.map(externalPort, internalPort, localHost, 'SwarmCast direct mode', 3600);
        this.mapper = check.mapper;
        const st = this.d.state.load();
        this.d.state.save({
          ...st,
          activeMapping: { kind: check.mapper.kind, id: check.mapper.id, externalPort, internalPort, createdAt: Date.now() },
        });
        // Leases expire; refresh every 30 minutes while active.
        this.renewTimer = setInterval(() => {
          void this.mapper?.map(externalPort, internalPort, localHost, 'SwarmCast direct mode', 3600).catch((e) => this.d.log.warn({ err: (e as Error).message }, 'port mapping renewal failed'));
        }, 30 * 60_000);
        this.renewTimer.unref();
      }
      this.cert = await this.d.issuer.issue(check.publicIp, { mapper: check.mapper, internalHost: localHost });
      this.ctx = tls.createSecureContext({ key: this.cert.keyPem, cert: this.cert.certPem });
      this.server = await this.d.startServer(internalPort, check.family === 4 ? '0.0.0.0' : '::', (_name, cb) => cb(null, this.ctx ?? undefined), {
        key: this.cert.keyPem,
        cert: this.cert.certPem,
      });
    } catch (err) {
      await this.teardown().catch(() => {});
      throw err;
    }
    this.active = true;
    this.publicIp = check.publicIp;
    this.externalPort = externalPort;
    this.internalPort = internalPort;
    this.viewersSeen.clear();
    const st = this.d.state.load();
    this.d.state.save({ ...st, lastDirectIp: check.publicIp, lastDirectAt: Date.now() });
    this.ipChanged = false;
    const host = check.family === 6 ? `[${check.publicIp}]` : check.publicIp;
    return `https://${host}:${externalPort}`;
  }

  get certificateSource(): IssuedCert['source'] | undefined {
    return this.cert?.source;
  }

  /** Close the server, remove the router mapping, forget the certificate, then verify. */
  async disable(): Promise<{ verified: boolean; details: string[] }> {
    const ip = this.publicIp;
    const port = this.externalPort;
    await this.teardown();
    const details: string[] = [];
    let verified = true;
    if (port && ip) {
      if (this.internalPort && (await isListeningLocal(this.internalPort))) {
        verified = false;
        details.push('local server still listening');
      }
      const probe = this.d.probe ?? tcpProbe;
      if (await probe(ip, port)) {
        verified = false;
        details.push(`port ${port} still answers from outside`);
      }
    }
    this.active = false;
    this.publicIp = undefined;
    this.externalPort = undefined;
    this.internalPort = undefined;
    this.viewersSeen.clear();
    return { verified, details };
  }

  private async teardown(): Promise<void> {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    await this.server?.close().catch(() => {});
    this.server = null;
    // Drop key material from memory.
    this.cert = null;
    this.ctx = null;
    if (this.mapper && this.externalPort) {
      const mapper = this.mapper;
      const port = this.externalPort;
      await mapper.unmap(port, this.internalPort);
      if (await mapper.hasMapping(port).catch(() => false)) {
        await mapper.unmap(port, this.internalPort);
        if (await mapper.hasMapping(port).catch(() => false)) throw new CodedError('err.routerPortOpen', { port });
      }
    } else if (this.mapper) {
      /* mapping never completed */
    }
    this.mapper = null;
    const st = this.d.state.load();
    if (st.activeMapping) this.d.state.save({ ...st, activeMapping: null });
  }

  noteViewer(sessionId: string): void {
    if (this.active) this.viewersSeen.add(sessionId);
  }

  snapshot(lastIp?: string): DirectModeState {
    const st = this.d.state.load();
    return {
      active: this.active,
      publicIp: this.publicIp,
      externalPort: this.externalPort,
      mapping: this.active ? (this.mapper?.kind ?? 'manual') : undefined,
      certificate: this.cert?.source,
      viewersSeen: this.viewersSeen.size,
      lastExposedIp: lastIp ?? st.lastDirectIp,
      ipChangedSinceLastDirect: this.ipChanged,
      staleMappingWarning: this.staleMapping,
    };
  }
}

export function ipChangeNotice(changed: boolean | null | undefined): CodedText | null {
  if (changed === true) return coded('direct.ipChanged');
  if (changed === false) return coded('direct.ipSame');
  return null;
}

export function ipChangeMessage(changed: boolean | null | undefined): string | null {
  return ipChangeNotice(changed)?.text ?? null;
}

function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean): void => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(2500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function isListeningLocal(port: number): Promise<boolean> {
  return tcpProbe('127.0.0.1', port);
}

export function randomId(): string {
  return crypto.randomBytes(4).toString('hex');
}
