import { describe, expect, it } from 'vitest';
import { collectCrates, crateLicenses, evaluateLicense, parseSpdx, renderCrateLicenses, shippedPackages } from '../crate-licenses.mjs';

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';

type Pkg = { name: string; version: string; license?: string | null; repository?: string; authors?: string[]; license_file?: string };

/** A minimal `cargo metadata` document: packages plus resolve edges with dependency kinds. */
function metadata(pkgs: Pkg[], edges: [from: string, to: string, kind: null | 'build' | 'dev'][]) {
  const id = (name: string) => `${CRATES_IO}#${name}@1.0.0`;
  const rootId = 'path+file:///app#app@0.2.0';
  const idOf = (name: string) => (name === 'app' ? rootId : id(name));
  return {
    packages: [
      { id: rootId, name: 'app', version: '0.2.0', license: 'MIT', source: null, manifest_path: '/app/Cargo.toml', authors: [] },
      ...pkgs.map((p) => ({ id: id(p.name), source: CRATES_IO, manifest_path: `/reg/${p.name}/Cargo.toml`, authors: [], license: 'MIT', version: '1.0.0', ...p })),
    ],
    workspace_members: [rootId],
    resolve: {
      root: rootId,
      nodes: [rootId, ...pkgs.map((p) => id(p.name))].map((nid) => ({
        id: nid,
        deps: edges.filter(([from]) => idOf(from) === nid).map(([, to, kind]) => ({ pkg: idOf(to), dep_kinds: [{ kind, target: null }] })),
      })),
    },
  };
}

const noFiles = () => [];
const canonical = (id: string) => (['MIT', 'MPL-2.0', 'BSD-3-Clause', 'Apache-2.0'].includes(id) ? `<${id} text>` : null);

describe('SPDX expressions', () => {
  it('parses OR, AND, WITH, parentheses and the legacy slash', () => {
    expect(parseSpdx('MIT')).toEqual({ type: 'license', id: 'MIT' });
    expect(parseSpdx('MIT/Apache-2.0')).toEqual({ type: 'or', args: [{ type: 'license', id: 'MIT' }, { type: 'license', id: 'Apache-2.0' }] });
    expect(parseSpdx('(MIT OR Apache-2.0) AND Unicode-3.0')).toEqual({
      type: 'and',
      args: [{ type: 'or', args: [{ type: 'license', id: 'MIT' }, { type: 'license', id: 'Apache-2.0' }] }, { type: 'license', id: 'Unicode-3.0' }],
    });
    // AND binds tighter than OR.
    expect(parseSpdx('A OR B AND C')).toEqual({ type: 'or', args: [{ type: 'license', id: 'A' }, { type: 'and', args: [{ type: 'license', id: 'B' }, { type: 'license', id: 'C' }] }] });
    expect(parseSpdx('Apache-2.0 WITH LLVM-exception OR MIT').type).toBe('or');
    expect(() => parseSpdx('MIT OR')).toThrow(/invalid licence expression/);
    expect(() => parseSpdx('(MIT')).toThrow(/missing \)/);
    expect(() => parseSpdx('')).toThrow(/empty/);
  });

  it('accepts an OR when one branch is allowed, an AND only when every part is', () => {
    expect(evaluateLicense('Unlicense OR MIT')).toEqual({ ok: true, chosen: ['MIT'], rejected: [] });
    expect(evaluateLicense('Zlib OR Apache-2.0 OR MIT').chosen).toEqual(['MIT']);
    expect(evaluateLicense('Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT').chosen).toEqual(['MIT']);
    expect(evaluateLicense('Apache-2.0 WITH LLVM-exception').ok).toBe(true);
    expect(evaluateLicense('(MIT OR Apache-2.0) AND Unicode-3.0').chosen).toEqual(['MIT', 'Unicode-3.0']);
    expect(evaluateLicense('Apache-2.0 AND ISC')).toMatchObject({ ok: true, chosen: ['Apache-2.0', 'ISC'] });
    expect(evaluateLicense('MIT AND GPL-3.0-only')).toMatchObject({ ok: false, rejected: ['GPL-3.0-only'] });
    expect(evaluateLicense('GPL-2.0 OR LGPL-2.1')).toMatchObject({ ok: false, rejected: ['GPL-2.0', 'LGPL-2.1'] });
    expect(evaluateLicense('Apache-2.0 WITH Some-exception').ok).toBe(false);
    expect(evaluateLicense('Unlicense').ok).toBe(false);
  });
});

describe('crates compiled into the app', () => {
  it('follows normal dependencies only (not build or dev ones) and skips the app itself', () => {
    const m = metadata(
      [{ name: 'tauri' }, { name: 'serde' }, { name: 'serde_derive' }, { name: 'tauri-build' }, { name: 'cc' }, { name: 'proptest' }],
      [
        ['app', 'tauri', null],
        ['app', 'serde', null],
        ['serde', 'serde_derive', null],
        ['app', 'tauri-build', 'build'],
        ['tauri-build', 'cc', null],
        ['app', 'proptest', 'dev'],
      ],
    );
    expect(shippedPackages(m).map((p: { name: string }) => p.name)).toEqual(['serde', 'serde_derive', 'tauri']);
  });

  it('sorts by name, then by version numerically', () => {
    const m = metadata([{ name: 'b' }, { name: 'a' }], [['app', 'b', null], ['app', 'a', null]]);
    m.packages.push({ id: 'x2', name: 'a', version: '1.10.0', license: 'MIT', source: CRATES_IO, manifest_path: '/r', authors: [] });
    m.packages.push({ id: 'x3', name: 'a', version: '1.9.0', license: 'MIT', source: CRATES_IO, manifest_path: '/r', authors: [] });
    m.resolve.nodes[0].deps.push({ pkg: 'x2', dep_kinds: [{ kind: null, target: null }] }, { pkg: 'x3', dep_kinds: [{ kind: null, target: null }] });
    m.resolve.nodes.push({ id: 'x2', deps: [] }, { id: 'x3', deps: [] });
    expect(shippedPackages(m).map((p: { name: string; version: string }) => `${p.name}@${p.version}`)).toEqual(['a@1.0.0', 'a@1.9.0', 'a@1.10.0', 'b@1.0.0']);
  });
});

describe('licence check and texts', () => {
  it('reports crates without a licence or with one outside the allowlist, and the build fails', () => {
    const m = metadata(
      [{ name: 'ok', license: 'MIT OR Apache-2.0' }, { name: 'nolicense', license: null, license_file: 'LICENSE.txt' }, { name: 'gpl', license: 'GPL-3.0-only' }, { name: 'broken', license: 'MIT OR' }],
      [['app', 'ok', null], ['app', 'nolicense', null], ['app', 'gpl', null], ['app', 'broken', null]],
    );
    const { problems } = collectCrates(shippedPackages(m), { readFiles: () => [{ name: 'LICENSE', text: 'x' }], canonical });
    expect(problems).toEqual([
      'broken 1.0.0: invalid licence expression "MIT OR": unexpected end',
      'gpl 1.0.0: "GPL-3.0-only" is not allowed (GPL-3.0-only)',
      'nolicense 1.0.0: no SPDX licence in Cargo.toml (only license-file = LICENSE.txt)',
    ]);
    expect(() => crateLicenses({ triple: 'x86_64-unknown-linux-gnu', metadata: m })).toThrow(/licence check failed for x86_64-unknown-linux-gnu:[\s\S]*GPL-3\.0-only/);
  });

  it('uses the crate files, else a same-repository crate, else the standard text with the authors', () => {
    const repo = 'https://github.com/x/objc2';
    const m = metadata(
      [
        { name: 'objc2', license: 'MIT', repository: repo, authors: ['Mads <m@x>'] },
        { name: 'objc2-foundation', license: 'MIT', repository: `${repo}.git` },
        { name: 'block2', license: 'MIT', repository: 'https://github.com/x/block2', authors: ['Mads <m@x>', 'Other'] },
        { name: 'selectors', license: 'MPL-2.0' },
        { name: 'zlibonly', license: 'Zlib' },
      ],
      [['app', 'objc2', null], ['app', 'objc2-foundation', null], ['app', 'block2', null], ['app', 'selectors', null], ['app', 'zlibonly', null]],
    );
    const files: Record<string, { name: string; text: string }[]> = { objc2: [{ name: 'LICENSE-MIT', text: 'Copyright Mads\r\nMIT terms  \n' }] };
    const { crates, problems } = collectCrates(shippedPackages(m), { readFiles: (p: { name: string }) => files[p.name] ?? [], canonical });
    const by = Object.fromEntries(crates.map((c: { name: string }) => [c.name, c]));
    expect(by.objc2.files).toEqual([{ name: 'LICENSE-MIT', text: 'Copyright Mads\nMIT terms' }]);
    expect(by['objc2-foundation'].files).toEqual(by.objc2.files);
    expect(by['objc2-foundation'].note).toMatch(/one of objc2 1\.0\.0, from the same repository/);
    expect(by.block2.files).toEqual([{ name: 'MIT (standard text)', text: 'Copyright (c) Mads, Other\n\n<MIT text>' }]);
    expect(by.selectors.files).toEqual([{ name: 'MPL-2.0 (standard text)', text: '<MPL-2.0 text>' }]);
    expect(by.selectors.note).not.toMatch(/copyright holders/);
    // No standard text for Zlib in this fake: the build must say what to add.
    expect(problems).toEqual(['zlibonly 1.0.0: no licence file in the crate and no standard text for Zlib (add scripts/build/licenses/Zlib.txt)']);
  });

  it('renders a deterministic list and prints each identical text once', () => {
    const m = metadata(
      [
        { name: 'b', license: 'MIT/Apache-2.0', repository: 'https://github.com/x/b' },
        { name: 'a', license: 'Apache-2.0' },
      ],
      [['app', 'b', null], ['app', 'a', null]],
    );
    const apache = 'Apache License\nVersion 2.0';
    const files: Record<string, { name: string; text: string }[]> = {
      a: [{ name: 'LICENSE', text: apache }],
      b: [{ name: 'LICENSE-APACHE', text: `  ${apache.replace('\n', '\n\n')}  ` }, { name: 'LICENSE-MIT', text: 'MIT by b' }],
    };
    const read = (p: { name: string }) => files[p.name] ?? [];
    const { crates } = collectCrates(shippedPackages(m), { readFiles: read, canonical });
    const text = renderCrateLicenses(crates, { triple: 'aarch64-apple-darwin' });
    expect(text).toContain('== Rust crates compiled into the SwarmCast desktop app (aarch64-apple-darwin) ==');
    expect(text).toContain('2 crates, as locked in apps/desktop/src-tauri/Cargo.lock');
    expect(text.indexOf('-- a 1.0.0 --')).toBeLessThan(text.indexOf('-- b 1.0.0 --'));
    expect(text).toContain('Licence: MIT/Apache-2.0 (used under MIT)');
    expect(text).toContain('Source: https://crates.io/crates/b/1.0.0 , https://github.com/x/b');
    expect(text).toContain('[LICENSE-APACHE] Same text as [LICENSE] of a 1.0.0 above.');
    expect(text.match(/Apache License/g)).toHaveLength(1);
    expect(text).toContain('[LICENSE-MIT]\nMIT by b');
    // Same input, same bytes.
    expect(renderCrateLicenses(collectCrates(shippedPackages(m), { readFiles: read, canonical }).crates, { triple: 'aarch64-apple-darwin' })).toBe(text);
  });
});
