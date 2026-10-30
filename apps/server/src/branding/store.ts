import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BRAND_MAX_DISK,
  BRAND_MAX_FILES,
  BRAND_SLOTS,
  buildPixPayload,
  deriveTheme,
  parseBrandUrl,
  themeCss,
  type BrandImageRef,
  type BrandSlot,
  type Branding,
  type BrandingText,
  type PublicBrandLink,
  type PublicBranding,
} from '@swarmcast/shared/branding';
import type { MessageKey } from '@swarmcast/shared/i18n';
import type { ActivityLog } from '../core/activity.js';
import type { Logger } from '../core/logger.js';
import { ensurePrivateDir } from '../core/paths.js';
import { normalizeBrandImage, type ImgError } from './image.js';

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
const FILE_RE = /^([0-9a-f]{64})\.(png|jpg|webp)$/;
/** Removing a master removes its variants. */
const VARIANTS: Partial<Record<BrandSlot, BrandSlot[]>> = { avatar: ['avatar128', 'fav32', 'fav180'], banner: ['banner640'] };
const SLOT_KEY: Partial<Record<BrandSlot, MessageKey>> = { avatar: 'brand.slot.avatar', banner: 'brand.slot.banner', card: 'brand.slot.card' };

export interface BrandFile {
  bytes: Buffer;
  type: 'png' | 'jpeg' | 'webp';
  mime: string;
}

export interface BrandingStoreOptions {
  /** `<data>/branding` (omitted in logic tests: memory only). */
  dir?: string;
  get: () => Branding;
  /** Persist the new branding (config.json). */
  save: (b: Branding) => void;
  activity: ActivityLog;
  log: Logger;
}

/**
 * Branding storage (plan §5.2): text and image references in config.json, images as
 * content-addressed files in `<data>/branding/` (0600), re-validated on load, held in memory
 * (≤ 1.5 MB), garbage-collected after every change. Serving never touches the disk.
 */
export class BrandingStore {
  private readonly files = new Map<string, BrandFile>();

  constructor(private readonly o: BrandingStoreOptions) {}

  private refs(b = this.o.get()): Array<[BrandSlot, BrandImageRef]> {
    return Object.entries(b.images).filter((e): e is [BrandSlot, BrandImageRef] => e[1] !== undefined);
  }

  /** Read and re-check every referenced file; drop what fails (with an activity line), then GC. */
  load(): void {
    const b = structuredClone(this.o.get());
    let changed = false;
    for (const [slot, ref] of this.refs(b)) {
      const name = `${ref.sha}.${EXT[ref.type]}`;
      let ok = false;
      if (this.o.dir) {
        try {
          const file = path.join(this.o.dir, name);
          const st = fs.statSync(file);
          if (st.isFile() && st.size <= BRAND_SLOTS[slot].maxBytes) {
            const bytes = fs.readFileSync(file);
            const r = normalizeBrandImage(bytes, slot);
            if (r.ok && r.bytes.equals(bytes) && sha256(bytes) === ref.sha) {
              this.files.set(ref.sha, { bytes, type: r.type, mime: MIME[r.type] });
              ok = true;
            }
          }
        } catch {
          /* missing or unreadable: dropped below */
        }
      } else ok = this.files.has(ref.sha);
      if (!ok) {
        delete b.images[slot];
        changed = true;
        const slotKey = SLOT_KEY[slot];
        if (slotKey) this.o.activity.add({ level: 'warn', kind: 'system', code: 'log.brand.imageDropped', params: { slotKey } });
        this.o.log.warn({ slot }, 'branding image could not be read; removed');
      }
    }
    if (changed) this.o.save(b);
    this.gc();
  }

  /** Delete files no reference points at (and anything misnamed). */
  private gc(): void {
    const live = new Set(this.refs().map(([, r]) => r.sha));
    for (const sha of [...this.files.keys()]) if (!live.has(sha)) this.files.delete(sha);
    if (!this.o.dir) return;
    let names: string[];
    try {
      names = fs.readdirSync(this.o.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m || !live.has(m[1]!)) {
        try {
          fs.rmSync(path.join(this.o.dir, name), { force: true, recursive: false });
        } catch {
          /* best effort; retried on the next change */
        }
      }
    }
  }

  /** The current branding config. */
  get branding(): Branding {
    return this.o.get();
  }

  file(sha: string): BrandFile | undefined {
    return this.files.get(sha);
  }

  disk(): { files: number; bytes: number } {
    let bytes = 0;
    for (const f of this.files.values()) bytes += f.bytes.length;
    return { files: this.files.size, bytes };
  }

  /** Validate, strip and store one variant; returns its reference. */
  putImage(slot: BrandSlot, input: Uint8Array): { ok: true; ref: BrandImageRef } | { ok: false; code: ImgError | 'img.disk'; params?: Record<string, number> } {
    const r = normalizeBrandImage(input, slot);
    if (!r.ok) return r;
    const sha = sha256(r.bytes);
    const b = structuredClone(this.o.get());
    const previous = b.images[slot];
    const others = this.refs(b).filter(([s]) => s !== slot);
    const shas = new Set(others.map(([, x]) => x.sha));
    let bytes = r.bytes.length;
    for (const s of shas) bytes += this.files.get(s)?.bytes.length ?? 0;
    if (!shas.has(sha) && (shas.size + 1 > BRAND_MAX_FILES || bytes > BRAND_MAX_DISK)) return { ok: false, code: 'img.disk' };
    if (this.o.dir) {
      ensurePrivateDir(this.o.dir);
      const file = path.join(this.o.dir, `${sha}.${EXT[r.type]}`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, r.bytes, { mode: 0o600 });
      fs.renameSync(tmp, file);
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    }
    this.files.set(sha, { bytes: r.bytes, type: r.type, mime: MIME[r.type] });
    const ref: BrandImageRef = { sha, type: r.type, w: r.w, h: r.h, bytes: r.bytes.length };
    b.images[slot] = ref;
    b.rev += 1;
    this.o.save(b);
    this.gc();
    if (previous?.sha !== sha && SLOT_KEY[slot]) this.o.activity.action('log.brand.imageSaved', { slotKey: SLOT_KEY[slot]! });
    return { ok: true, ref };
  }

  removeImage(slot: BrandSlot): void {
    const b = structuredClone(this.o.get());
    for (const s of [slot, ...(VARIANTS[slot] ?? [])]) delete b.images[s];
    b.rev += 1;
    this.o.save(b);
    this.gc();
    if (SLOT_KEY[slot]) this.o.activity.action('log.brand.imageRemoved', { slotKey: SLOT_KEY[slot]! });
  }

  /** Save the text part (already validated by brandingTextSchema). */
  saveText(t: BrandingText): Branding {
    const b = { ...structuredClone(this.o.get()), ...t };
    b.rev += 1;
    this.o.save(b);
    this.o.activity.action('log.brand.saved');
    return b;
  }

  reset(): Branding {
    const rev = this.o.get().rev + 1;
    const b = { ...defaults(), rev };
    this.o.save(b);
    this.gc();
    this.o.activity.action('log.brand.reset');
    return b;
  }

  /** URL of an image for viewers (`/brand/…`) or the panel (`/api/branding/file/…`). */
  static url(ref: BrandImageRef | undefined, base: '/brand/' | '/api/branding/file/'): string | undefined {
    return ref ? `${base}${ref.sha}.${EXT[ref.type]}` : undefined;
  }

  /** What viewer pages get (null while branding is off). Links are re-checked against the stream's host. */
  publicBranding(opts: { ownHost?: string; lite?: boolean; base?: '/brand/' | '/api/branding/file/' } = {}): PublicBranding | null {
    const b = this.o.get();
    if (!b.enabled) return null;
    const base = opts.base ?? '/brand/';
    const link = (label: string, href: string): PublicBrandLink | null => {
      const r = parseBrandUrl(href, { ownHost: opts.ownHost });
      return r.ok ? { label, href: r.href, display: r.display, platform: r.platform } : null;
    };
    const img = b.images;
    const out: PublicBranding = {
      rev: b.rev,
      ...(opts.lite ? { lite: true } : {}),
      ...(b.name ? { name: b.name } : {}),
      ...(b.tagline ? { tagline: b.tagline } : {}),
      ...(b.about ? { about: b.about } : {}),
      tags: b.tags,
      links: b.links.map((l) => link(l.label, l.url)).filter((l): l is PublicBrandLink => l !== null),
      theme: { preset: b.theme.preset, corners: b.theme.corners },
      ...(b.endedMessage ? { endedMessage: b.endedMessage } : {}),
      showCredit: b.showCredit,
    };
    const s = b.support;
    if (s.enabled) {
      if (s.mode === 'pix' && s.pix) {
        const p = buildPixPayload({ key: s.pix.key, name: s.pix.name, city: s.pix.city });
        if (p.ok) out.support = { label: s.label, pix: { type: s.pix.type, key: s.pix.key, name: s.pix.name, payload: p.payload } };
      } else if (s.mode === 'link' && s.url) {
        const l = link('', s.url);
        if (l) out.support = { label: s.label, link: l };
      }
    }
    if (img.avatar) out.avatar = { s256: BrandingStore.url(img.avatar, base)!, ...(img.avatar128 ? { s128: BrandingStore.url(img.avatar128, base)! } : {}) };
    if (img.fav32) out.favicon = { s32: BrandingStore.url(img.fav32, base)!, ...(img.fav180 ? { s180: BrandingStore.url(img.fav180, base)! } : {}) };
    if (img.banner && !opts.lite) out.banner = { s1280: BrandingStore.url(img.banner, base)!, ...(img.banner640 ? { s640: BrandingStore.url(img.banner640, base)! } : {}), ...(b.bannerAlt ? { alt: b.bannerAlt } : {}) };
    return out;
  }

  /** `/brand/theme.css` ('' while branding is off). */
  themeCss(): string {
    const b = this.o.get();
    if (!b.enabled) return '';
    return themeCss(deriveTheme(b.theme), b.theme.corners);
  }
}

function sha256(b: Uint8Array): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}

function defaults(): Branding {
  return {
    enabled: true,
    tags: [],
    links: [],
    support: { enabled: false, label: 'support', mode: 'link' },
    theme: { preset: 'forest', corners: 'round' },
    preview: { enabled: false },
    showCredit: true,
    images: {},
    rev: 0,
  };
}
