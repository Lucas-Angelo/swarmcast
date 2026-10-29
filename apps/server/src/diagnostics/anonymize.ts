import crypto from 'node:crypto';
import { IPV4, IPV6_FULL, IPV6_SHORT } from '../core/activity.js';
import { scrub } from '../core/logger.js';
import { parseIp } from '../security/cidr.js';

/** JSON fields of log records that hold a viewer's nickname. */
const NICK_KEYS = new Set(['nickname', 'nick', 'viewer', 'reporter', 'accused']);
/** JSON fields whose string values are always removed (pino REDACT already covers most of them). */
const SECRET_KEY = /secret|token|password|passwd|streamkey|livelink|privatekey|pem|cookie|authorization|set-cookie/i;
/** Fast first pass: nickname fields in JSON lines, without parsing every line. */
const NICK_FIELD = /"(?:nickname|nick|viewer|reporter|accused)":"((?:[^"\\]|\\.){1,200})"/g;
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g;
/** A quick tunnel's host name is part of the live link: keep only the domain. */
const QUICK_TUNNEL_HOST = /\b[a-z0-9-]+\.trycloudflare\.com\b/gi;
/** Nicknames shorter than this are only replaced in their own JSON fields, not in free text. */
const MIN_TEXT_NICK = 3;
/** IPv4-mapped IPv6 (`::ffff:203.0.113.7`): one label, the same as the plain IPv4 address. */
const IPV4_MAPPED = /(?<![0-9a-f:])::ffff:(?:\d{1,3}\.){3}\d{1,3}\b/gi;
/**
 * An IPv6 prefix or partial address written without "::" (`2804:1b3:61c1:c649`, the /64 of a
 * home network): 3 to 7 groups, the first one a full 4-digit group of global unicast
 * (2000::/3), unique-local (fc00::/7) or link-local (fe80::/10) space. That keeps clock times
 * (12:34:56), MAC addresses and fingerprints (2-digit groups), file:line:col positions (preceded
 * by ":") and hex digests (no colons) as they are.
 */
const IPV6_PREFIX = /(?<![0-9a-z:.])(?:[23][0-9a-f]{3}|f[cd][0-9a-f]{2}|fe[89ab][0-9a-f])(?::[0-9a-f]{1,4}){2,6}(?![0-9a-z:]|\.\d)/gi;

/**
 * Last labels of the host names that get a label: common generic TLDs, country TLDs that are not
 * also file extensions or everyday words (no .md, .py, .sh, .rs, .js, .ts, .app, .in, .is, .it,
 * .to…), and local-network suffixes. Lowercase only: JavaScript names (`Logger.info`,
 * `this.access.live`) are not host names.
 */
const HOST_TLDS = [
  'com', 'net', 'org', 'io', 'dev', 'co', 'tv', 'xyz', 'ai', 'gg', 'biz', 'cloud', 'online', 'site',
  'eu', 'uk', 'us', 'ca', 'de', 'fr', 'es', 'nl', 'pt', 'br', 'ar', 'mx', 'cl', 'uy', 'jp', 'au', 'nz', 'ru', 'cn', 'ch', 'se', 'fi', 'dk', 'cz',
  'local', 'lan', 'localdomain', 'internal', 'arpa',
];
const HOST_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
/** A dotted host name ending in one of HOST_TLDS, not part of a longer word, file name or call. */
const HOSTNAME = new RegExp(`(?<![\\w.-])(?:${HOST_LABEL}\\.)+(?:${HOST_TLDS.join('|')})(?![\\w(-]|\\.[A-Za-z0-9])`, 'g');
/** A run of name characters that is not the tail of a longer word or name (candidates for known host names). */
const NAME_TOKEN = /(?<![\w.-])[A-Za-z0-9][A-Za-z0-9.-]*/g;
/** Domains kept as they are: the services SwarmCast talks to, and its own site. */
const VENDOR_DOMAINS = [
  'trycloudflare.com', 'cloudflare.com', 'cloudflare-dns.com', 'argotunnel.com', 'one.one.one.one',
  'github.com', 'githubusercontent.com', 'githubassets.com', 'lucas-angelo.github.io',
  'letsencrypt.org', 'spamhaus.org', 'firehol.org', 'abuse.ch',
  'obsproject.com', 'ffmpeg.org', 'martin-riedl.de', 'gyan.dev',
  'nodejs.org', 'npmjs.com', 'npmjs.org', 'microsoft.com', 'windows.com', 'apple.com', 'mozilla.org', 'google.com', 'googleapis.com', 'ubuntu.com',
];
/** Local-network and dynamic-DNS suffixes: kept after the label (they say what kind of name it was). */
const KEPT_SUFFIXES = [
  'local', 'lan', 'localdomain', 'internal', 'home.arpa',
  'duckdns.org', 'no-ip.org', 'no-ip.com', 'no-ip.biz', 'ddns.net', 'hopto.org', 'zapto.org', 'sytes.net', 'myftp.org', 'myftp.biz',
  'serveftp.com', 'servehttp.com', 'dynu.net', 'dynu.com', 'dyndns.org', 'dynv6.net', 'freeddns.org', 'mooo.com', 'afraid.org', 'changeip.com', 'ddnsfree.com',
];

const endsWithDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export interface AnonymizerOptions {
  /** Keep IP addresses as they are (the developer asked for them). Default false. */
  includeFullIps?: boolean;
  /** Exact strings that must never appear (stream key, live link, join/panel tokens, session ids). */
  secrets?: Iterable<string | undefined>;
  /** Nicknames known up front (current viewers, activity log). */
  nicknames?: Iterable<string>;
  /** The user's home folder, written as `~` (folder paths carry the account name). */
  homeDir?: string;
  /**
   * Host names known up front (the external tunnel's address, this computer's name): hashed
   * wherever they appear, even without a TLD the generic pattern knows. URLs are reduced to
   * their host. A bare computer name only counts when it has a digit or a "-" (`DESKTOP-4F3K2L`,
   * `Anas-MacBook-Pro`): a plain word such as "server" would hide half the log.
   */
  hostnames?: Iterable<string | undefined>;
  /** Random per export unless given (tests). */
  salt?: Buffer;
}

/**
 * Anonymises the text that goes into a log export.
 *
 * - Every line goes through `scrub()` again (link/panel tokens, stream keys), plus exact
 *   matches of the secrets the app knows, private key blocks and quick-tunnel host names.
 * - IP addresses (v4 and v6, except loopback / unspecified) become `ip-<8 hex>`: an HMAC with a
 *   random salt made for this export only, so one address keeps one label inside the export
 *   (the developer can follow a viewer) but the labels cannot be reversed or matched across
 *   exports. With `includeFullIps` they are kept.
 * - Host names (machine names on the local network, dynamic-DNS names, a custom tunnel's
 *   address) become `host-<8 hex>` the same way, always (also with `includeFullIps`); the
 *   services SwarmCast talks to (Cloudflare, GitHub…) are kept.
 * - Nicknames become `viewer-<8 hex>` the same way, in their JSON fields and in free text.
 * - The home folder becomes `~`.
 */
export class Anonymizer {
  private readonly salt: Buffer;
  private readonly secrets: string[];
  private readonly nicks = new Map<string, string>();
  private nickRe: RegExp | null = null;
  private nickReStale = false;
  private readonly home: Array<[string, string]>;
  /** Lowercase host names known up front (matched as whole names, never turned into a pattern). */
  private readonly knownHosts: Set<string>;

  constructor(private readonly o: AnonymizerOptions = {}) {
    this.salt = o.salt ?? crypto.randomBytes(32);
    // Longest first, so a secret that contains another one is removed whole.
    this.secrets = [...new Set([...(o.secrets ?? [])].filter((s): s is string => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length);
    for (const n of o.nicknames ?? []) this.addNickname(n);
    const h = o.homeDir && o.homeDir.length > 3 ? o.homeDir : null;
    // Plain, and as it appears inside JSON strings on Windows (escaped backslashes).
    this.home = h ? [[h.replace(/\\/g, '\\\\'), '~'], [h, '~']] : [];
    this.knownHosts = new Set([...(o.hostnames ?? [])].map(hostOf).filter((x): x is string => !!x));
  }

  private hash(kind: string, value: string): string {
    return crypto.createHmac('sha256', this.salt).update(`${kind}\0${value}`).digest('hex').slice(0, 8);
  }

  /** Label of one IP address (normalised, so `::ffff:1.2.3.4` and `1.2.3.4` match). */
  ipLabel(ip: string): string {
    const p = parseIp(ip);
    if (!p) return ip;
    return `ip-${this.hash('ip', `${p.v}:${p.n.toString()}`)}`;
  }

  /** Label of one host name: `host-<8 hex>`, plus a local or dynamic-DNS suffix when it has one. */
  hostLabel(host: string): string {
    const h = host.toLowerCase();
    const suffix = KEPT_SUFFIXES.find((d) => h !== d && endsWithDomain(h, d));
    return `host-${this.hash('host', h)}${suffix ? `.${suffix}` : ''}`;
  }

  private maskHosts(s: string): string {
    if (this.knownHosts.size) {
      s = s.replace(NAME_TOKEN, (token: string, at: number, all: string) => {
        // A name never ends with "." or "-": that is the sentence or the text around it.
        const name = token.replace(/[.-]+$/, '');
        if (all[at + name.length] === '_' || !this.knownHosts.has(name.toLowerCase())) return token;
        return this.hostLabel(name) + token.slice(name.length);
      });
    }
    return s.replace(HOSTNAME, (h) => (VENDOR_DOMAINS.some((d) => endsWithDomain(h.toLowerCase(), d)) ? h : this.hostLabel(h)));
  }

  nickLabel(nickname: string): string {
    const known = this.nicks.get(nickname);
    if (known) return known;
    const label = `viewer-${this.hash('nick', nickname.normalize('NFC'))}`;
    this.nicks.set(nickname, label);
    this.nickReStale = true;
    return label;
  }

  addNickname(nickname: string): void {
    if (typeof nickname === 'string' && nickname.trim()) this.nickLabel(nickname);
  }

  /** First pass over a file or text: learn the nicknames in its JSON fields. */
  learn(text: string): void {
    for (const m of text.matchAll(NICK_FIELD)) {
      try {
        this.addNickname(JSON.parse(`"${m[1]}"`) as string);
      } catch {
        /* broken escape */
      }
    }
  }

  private nickPattern(): RegExp | null {
    if (this.nickReStale) {
      const names = [...this.nicks.keys()].filter((n) => [...n].length >= MIN_TEXT_NICK).sort((a, b) => b.length - a.length);
      this.nickRe = names.length
        ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}_])`, 'gu')
        : null;
      this.nickReStale = false;
    }
    return this.nickRe;
  }

  private maskIps(s: string): string {
    if (this.o.includeFullIps) return s;
    return s
      .replace(IPV4_MAPPED, (ip) => (parseIp(ip) ? this.ipLabel(ip) : ip))
      .replace(IPV4, (ip) => (ip.startsWith('127.') || ip === '0.0.0.0' || !parseIp(ip) ? ip : this.ipLabel(ip)))
      .replace(IPV6_FULL, (ip, at: number, all: string) => (parseIp(ip) && !colonData(ip, at, all) ? this.ipLabel(ip) : ip))
      .replace(IPV6_SHORT, (ip) => (ip === '::' || ip === '::1' || !parseIp(ip) ? ip : this.ipLabel(ip)))
      // Groups only: label it as the prefix it is (`2804:1b3:61c1:c649` = `2804:1b3:61c1:c649::`).
      // Written by software, a prefix has no zero-padded group ("2000:00:00" is a duration).
      .replace(IPV6_PREFIX, (ip, at: number, all: string) =>
        parseIp(`${ip}::`) && !colonData(ip, at, all) && !/(?:^|:)0[0-9a-f]/i.test(ip) ? this.ipLabel(`${ip}::`) : ip,
      );
  }

  /** Free text (one line or a whole document). */
  text(input: string): string {
    let s = input.replace(PEM, '[redacted key]');
    for (const secret of this.secrets) if (s.includes(secret)) s = s.split(secret).join('[redacted]');
    s = scrub(s).replace(QUICK_TUNNEL_HOST, '[tunnel].trycloudflare.com');
    for (const [from, to] of this.home) if (s.includes(from)) s = s.split(from).join(to);
    s = this.maskIps(s);
    s = this.maskHosts(s);
    const re = this.nickPattern();
    if (re) s = s.replace(re, (n) => this.nicks.get(n) ?? n);
    return s;
  }

  /** A JSON value: nickname fields get labels, secret fields are removed, every string is anonymised. */
  json(value: unknown, key?: string): unknown {
    if (typeof value === 'string') {
      if (key && SECRET_KEY.test(key)) return '[redacted]';
      if (key && NICK_KEYS.has(key)) return this.nickLabel(value);
      return this.text(value);
    }
    if (Array.isArray(value)) return value.map((v) => this.json(v, key));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[this.text(k)] = this.json(v, k);
      return out;
    }
    return value;
  }

  /** One log line: pino JSON records field by field, anything else as text. */
  line(line: string): string {
    const t = line.trimStart();
    if (t.startsWith('{')) {
      try {
        return JSON.stringify(this.json(JSON.parse(t)));
      } catch {
        /* not JSON after all */
      }
    }
    return this.text(line);
  }

  /**
   * A whole log file. Gives the event loop a turn every few thousand lines, so a big export
   * never stalls a running live (viewers' requests, OBS).
   */
  async file(text: string): Promise<string> {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) lines[i] = this.line(lines[i]!);
      if (i % 2000 === 1999) await new Promise((r) => setImmediate(r));
    }
    return lines.join('\n');
  }
}

/** The host of a URL or a host name; nothing for an IP address, a vendor domain or a plain word. */
function hostOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let host = value.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || parseIp(host)) return undefined;
  if (!host.includes('.') && !/[\d-]/.test(host)) return undefined;
  if (host.length < 4 || VENDOR_DOMAINS.some((d) => endsWithDomain(host, d)) || host === 'localhost') return undefined;
  return host;
}

/**
 * Colon-separated hex that is not an address: part of a long run (a certificate or key
 * fingerprint: 3A:4B:…, 16 to 32 groups; an address with a port has at most 9) or groups of
 * exactly two digits (a MAC address or a fingerprint fragment; addresses are not written so).
 */
function colonData(match: string, at: number, all: string): boolean {
  if (match.split(':').every((g) => g.length === 2)) return true;
  let start = at;
  let end = at + match.length;
  while (start > 0 && /[0-9a-f:]/i.test(all[start - 1]!)) start--;
  while (end < all.length && /[0-9a-f:]/i.test(all[end]!)) end++;
  return all.slice(start, end).split(':').length >= 10;
}
