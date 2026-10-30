// The licence list of the Rust crates compiled into the desktop app (crate-licenses.mjs): SPDX
// expressions against the allowlist, which crates ship (normal dependencies only), where each
// licence text comes from, and a deterministic rendering. In SPDX, AND binds tighter than OR.
import { describe, expect, it } from 'vitest';
import { collectCrates, crateLicenses, evaluateLicense, parseSpdx, renderCrateLicenses, shippedPackages } from '../crate-licenses.mjs';

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';

type Pkg = { name: string; version: string; license?: string | null; repository?: string; authors?: string[]; license_file?: string };
type LicenceFile = { name: string; text: string };

/** A minimal `cargo metadata` document: packages plus resolve edges with dependency kinds. */
function metadata(pkgs: Array<Partial<Pkg> & { name: string }>, edges: [from: string, to: string, kind: null | 'build' | 'dev'][]) {
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

/** Each crate a normal dependency of the app. */
const direct = (...names: string[]): [string, string, null][] => names.map((n) => ['app', n, null]);
/** The standard texts this fake knows (scripts/build/licenses/ has the real ones). */
const canonical = (id: string) => (['MIT', 'MPL-2.0', 'BSD-3-Clause', 'Apache-2.0'].includes(id) ? `<${id} text>` : null);
/** readFiles from a table of licence files per crate name. */
const filesOf = (table: Record<string, LicenceFile[]>) => (p: { name: string }) => table[p.name] ?? [];
const MIT = { type: 'license', id: 'MIT' };
const APACHE = { type: 'license', id: 'Apache-2.0' };

describe('SPDX expressions', () => {
  it.each([
    ['MIT', MIT],
    ['MIT/Apache-2.0', { type: 'or', args: [MIT, APACHE] }],
    ['(MIT OR Apache-2.0) AND Unicode-3.0', { type: 'and', args: [{ type: 'or', args: [MIT, APACHE] }, { type: 'license', id: 'Unicode-3.0' }] }],
    ['A OR B AND C', { type: 'or', args: [{ type: 'license', id: 'A' }, { type: 'and', args: [{ type: 'license', id: 'B' }, { type: 'license', id: 'C' }] }] }],
  ])('parses %j (OR, AND, parentheses and the legacy slash)', (expression, tree) => {
    // Act
    const parsed = parseSpdx(expression);

    // Assert
    expect(parsed).toEqual(tree);
  });

  it('parses WITH as part of its licence', () => {
    // Act
    const parsed = parseSpdx('Apache-2.0 WITH LLVM-exception OR MIT');

    // Assert
    expect(parsed.type).toBe('or');
  });

  it.each([
    ['MIT OR', /invalid licence expression/],
    ['(MIT', /missing \)/],
    ['', /empty/],
  ])('refuses %j', (expression, error) => {
    // Act
    const parse = () => parseSpdx(expression);

    // Assert
    expect(parse).toThrow(error);
  });

  it.each([
    ['Unlicense OR MIT', { ok: true, chosen: ['MIT'], rejected: [] }],
    ['Zlib OR Apache-2.0 OR MIT', { chosen: ['MIT'] }],
    ['Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT', { chosen: ['MIT'] }],
    ['Apache-2.0 WITH LLVM-exception', { ok: true }],
    ['(MIT OR Apache-2.0) AND Unicode-3.0', { chosen: ['MIT', 'Unicode-3.0'] }],
    ['Apache-2.0 AND ISC', { ok: true, chosen: ['Apache-2.0', 'ISC'] }],
  ])('accepts %j: an OR when one branch is allowed, an AND when every part is', (expression, verdict) => {
    // Act
    const result = evaluateLicense(expression);

    // Assert
    expect(result).toMatchObject(verdict);
  });

  it.each([
    ['MIT AND GPL-3.0-only', { ok: false, rejected: ['GPL-3.0-only'] }],
    ['GPL-2.0 OR LGPL-2.1', { ok: false, rejected: ['GPL-2.0', 'LGPL-2.1'] }],
    ['Apache-2.0 WITH Some-exception', { ok: false }],
    ['Unlicense', { ok: false }],
  ])('rejects %j', (expression, verdict) => {
    // Act
    const result = evaluateLicense(expression);

    // Assert
    expect(result).toMatchObject(verdict);
  });
});

describe('crates compiled into the app', () => {
  it('follows normal dependencies only (not build or dev ones) and skips the app itself', () => {
    // Arrange
    const m = metadata(
      [{ name: 'tauri' }, { name: 'serde' }, { name: 'serde_derive' }, { name: 'tauri-build' }, { name: 'cc' }, { name: 'proptest' }],
      [...direct('tauri', 'serde'), ['serde', 'serde_derive', null], ['app', 'tauri-build', 'build'], ['tauri-build', 'cc', null], ['app', 'proptest', 'dev']],
    );

    // Act
    const shipped = shippedPackages(m);

    // Assert
    expect(shipped.map((p: { name: string }) => p.name)).toEqual(['serde', 'serde_derive', 'tauri']);
  });

  it('sorts by name, then by version numerically', () => {
    // Arrange
    const m = metadata([{ name: 'b' }, { name: 'a' }], direct('b', 'a'));
    for (const [id, version] of [['x2', '1.10.0'], ['x3', '1.9.0']] as const) {
      m.packages.push({ id, name: 'a', version, license: 'MIT', source: CRATES_IO, manifest_path: '/r', authors: [] });
      m.resolve.nodes[0]!.deps.push({ pkg: id, dep_kinds: [{ kind: null, target: null }] });
      m.resolve.nodes.push({ id, deps: [] });
    }

    // Act
    const shipped = shippedPackages(m);

    // Assert
    expect(shipped.map((p: { name: string; version: string }) => `${p.name}@${p.version}`)).toEqual(['a@1.0.0', 'a@1.9.0', 'a@1.10.0', 'b@1.0.0']);
  });
});

describe('licence check and texts', () => {
  it('reports crates without a licence or with one outside the allowlist', () => {
    // Arrange
    const m = metadata(
      [{ name: 'ok', license: 'MIT OR Apache-2.0' }, { name: 'nolicense', license: null, license_file: 'LICENSE.txt' }, { name: 'gpl', license: 'GPL-3.0-only' }, { name: 'broken', license: 'MIT OR' }],
      direct('ok', 'nolicense', 'gpl', 'broken'),
    );

    // Act
    const { problems } = collectCrates(shippedPackages(m), { readFiles: () => [{ name: 'LICENSE', text: 'x' }], canonical });

    // Assert
    expect(problems).toEqual([
      'broken 1.0.0: invalid licence expression "MIT OR": unexpected end',
      'gpl 1.0.0: "GPL-3.0-only" is not allowed (GPL-3.0-only)',
      'nolicense 1.0.0: no SPDX licence in Cargo.toml (only license-file = LICENSE.txt)',
    ]);
  });

  it('the build fails on a crate outside the allowlist, naming the target and the licence', () => {
    // Arrange
    const m = metadata([{ name: 'gpl', license: 'GPL-3.0-only' }], direct('gpl'));

    // Act
    const build = () => crateLicenses({ triple: 'x86_64-unknown-linux-gnu', metadata: m });

    // Assert
    expect(build).toThrow(/licence check failed for x86_64-unknown-linux-gnu:[\s\S]*GPL-3\.0-only/);
  });

  it('uses the crate files (CRLF and trailing spaces tidied), else a same-repository crate, else the standard text with the authors', () => {
    // Arrange
    const repo = 'https://github.com/x/objc2';
    const m = metadata(
      [
        { name: 'objc2', license: 'MIT', repository: repo, authors: ['Mads <m@x>'] },
        { name: 'objc2-foundation', license: 'MIT', repository: `${repo}.git` },
        { name: 'block2', license: 'MIT', repository: 'https://github.com/x/block2', authors: ['Mads <m@x>', 'Other <o@x> (Org) <p@x>'] },
        { name: 'selectors', license: 'MPL-2.0' },
        { name: 'zlibonly', license: 'Zlib' },
      ],
      direct('objc2', 'objc2-foundation', 'block2', 'selectors', 'zlibonly'),
    );
    const readFiles = filesOf({ objc2: [{ name: 'LICENSE-MIT', text: 'Copyright Mads\r\nMIT terms  \n' }] });

    // Act
    const { crates, problems } = collectCrates(shippedPackages(m), { readFiles, canonical });

    // Assert
    const by = Object.fromEntries(crates.map((c: { name: string }) => [c.name, c]));
    expect(by.objc2.files).toEqual([{ name: 'LICENSE-MIT', text: 'Copyright Mads\nMIT terms' }]);
    expect(by['objc2-foundation'].files).toEqual(by.objc2.files);
    expect(by['objc2-foundation'].note).toMatch(/one of objc2 1\.0\.0, from the same repository/);
    expect(by.block2.files).toEqual([{ name: 'MIT (standard text)', text: 'Copyright (c) Mads, Other (Org)\n\n<MIT text>' }]);
    expect(by.selectors.files).toEqual([{ name: 'MPL-2.0 (standard text)', text: '<MPL-2.0 text>' }]);
    expect(by.selectors.note).not.toMatch(/copyright holders/);
    expect(problems).toEqual(['zlibonly 1.0.0: no licence file in the crate and no standard text for Zlib (add scripts/build/licenses/Zlib.txt)']);
  });

  it('renders a deterministic list and prints each identical text once', () => {
    // Arrange
    const m = metadata(
      [
        { name: 'b', license: 'MIT/Apache-2.0', repository: 'https://github.com/x/b' },
        { name: 'a', license: 'Apache-2.0' },
      ],
      direct('b', 'a'),
    );
    const apache = 'Apache License\nVersion 2.0';
    const readFiles = filesOf({
      a: [{ name: 'LICENSE', text: apache }],
      b: [{ name: 'LICENSE-APACHE', text: `  ${apache.replaceAll('\n', '\n\n')}  ` }, { name: 'LICENSE-MIT', text: 'MIT by b' }],
    });
    const render = () => renderCrateLicenses(collectCrates(shippedPackages(m), { readFiles, canonical }).crates, { triple: 'aarch64-apple-darwin' });

    // Act
    const text = render();

    // Assert
    expect(text).toContain('== Rust crates compiled into the SwarmCast desktop app (aarch64-apple-darwin) ==');
    expect(text).toContain('2 crates, as locked in apps/desktop/src-tauri/Cargo.lock');
    expect(text.indexOf('-- a 1.0.0 --')).toBeLessThan(text.indexOf('-- b 1.0.0 --'));
    expect(text).toContain('Licence: MIT/Apache-2.0 (used under MIT)');
    expect(text).toContain('Source: https://crates.io/crates/b/1.0.0 , https://github.com/x/b');
    expect(text).toContain('[LICENSE-APACHE] Same text as [LICENSE] of a 1.0.0 above.');
    expect(text.match(/Apache License/g)).toHaveLength(1);
    expect(text).toContain('[LICENSE-MIT]\nMIT by b');
    expect(render()).toBe(text);
  });
});
