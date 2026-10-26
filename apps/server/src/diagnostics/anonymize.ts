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

export interface AnonymizerOptions {
  /** Keep IP addresses as they are (the developer asked for them). Default false. */
  includeFullIps?: boolean;
  /** Exact strings that must never appear (stream key, live link, join/panel tokens, session ids). */
  secrets?: Iterable<string | undefined>;
  /** Nicknames known up front (current viewers, activity log). */
  nicknames?: Iterable<string>;
  /** The user's home folder, written as `~` (folder paths carry the account name). */
  homeDir?: string;
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

  constructor(private readonly o: AnonymizerOptions = {}) {
    this.salt = o.salt ?? crypto.randomBytes(32);
    // Longest first, so a secret that contains another one is removed whole.
    this.secrets = [...new Set([...(o.secrets ?? [])].filter((s): s is string => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length);
    for (const n of o.nicknames ?? []) this.addNickname(n);
    const h = o.homeDir && o.homeDir.length > 3 ? o.homeDir : null;
    // Plain, and as it appears inside JSON strings on Windows (escaped backslashes).
    this.home = h ? [[h.replace(/\\/g, '\\\\'), '~'], [h, '~']] : [];
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
      .replace(IPV6_FULL, (ip) => (parseIp(ip) ? this.ipLabel(ip) : ip))
      .replace(IPV6_SHORT, (ip) => (ip === '::' || ip === '::1' || !parseIp(ip) ? ip : this.ipLabel(ip)));
  }

  /** Free text (one line or a whole document). */
  text(input: string): string {
    let s = input.replace(PEM, '[redacted key]');
    for (const secret of this.secrets) if (s.includes(secret)) s = s.split(secret).join('[redacted]');
    s = scrub(s).replace(QUICK_TUNNEL_HOST, '[tunnel].trycloudflare.com');
    for (const [from, to] of this.home) if (s.includes(from)) s = s.split(from).join(to);
    s = this.maskIps(s);
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
