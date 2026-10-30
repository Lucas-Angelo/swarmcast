// The viewer build (apps/viewer/dist): no chunk that a page loads may import another page's entry
// chunk (its watch.ts, join.ts... or the PoW worker), since importing it runs that whole script
// there. The branding chunk, which the join page loads too, once imported the bundler's runtime
// helper from the watch entry chunk, and the join page then ran the watch page's script along with
// its branding. A chunk only its own page loads may import that page's entry (the chat chunk
// imports the watch entry for the order of its side effects: harmless, the watch page ran it).
// Read from the built files, once (@bundle: the chromium project only, see playwright.config.ts).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { DIST, requireBuild } from './watch-page.js';

test.beforeAll(requireBuild);

const ASSETS = path.join(DIST, 'assets');
/** `import … from "./x.js"`, `export … from "./x.js"`, `import "./x.js"` and `import("./x.js")`, any quotes. */
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]\.\/([\w.-]+\.js)["'`]/g;
/** `new Worker(new URL("/assets/x.js", …))`: a worker's entry chunk. */
const WORKER = /new Worker\(\s*new URL\(\s*["'`]\/assets\/([\w.-]+\.js)["'`]/g;

/** The content hash Vite puts after a chunk's name. */
const HASH = /-[\w-]{8}\.js$/;

const chunks = (): string[] => fs.readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
const read = (chunk: string): string => fs.readFileSync(path.join(ASSETS, chunk), 'utf8');

/**
 * What loads first in each page and worker: page name -> its root chunk. A page's entry chunk is
 * named after the page (join-…, watch-…); a page whose script has no code of its own (invalid)
 * starts straight on a shared chunk, which is not an entry.
 */
function roots(): Map<string, string> {
  const out = new Map<string, string>();
  for (const page of fs.readdirSync(DIST).filter((f) => f.endsWith('.html'))) {
    const src = /<script type="module"[^>]*src="\/assets\/([\w.-]+\.js)"/.exec(fs.readFileSync(path.join(DIST, page), 'utf8'))?.[1];
    if (src) out.set(page.replace(/\.html$/, ''), src);
  }
  for (const chunk of chunks()) for (const m of read(chunk).matchAll(WORKER)) out.set(m[1]!.replace(HASH, ''), m[1]!);
  return out;
}

/** Each chunk's imports (static and dynamic) of other chunks. */
function importGraph(): Map<string, string[]> {
  return new Map(chunks().map((chunk) => [chunk, [...read(chunk).matchAll(IMPORT)].map((m) => m[1]!)]));
}

/** Every chunk that can load from `root`. */
function reachable(graph: Map<string, string[]>, root: string): Set<string> {
  const seen = new Set<string>();
  const visit = (c: string): void => {
    if (seen.has(c)) return;
    seen.add(c);
    for (const next of graph.get(c) ?? []) visit(next);
  };
  visit(root);
  return seen;
}

test('no chunk a page loads imports the entry chunk of another page or worker @bundle', () => {
  // Arrange
  const pages = roots();
  const graph = importGraph();
  const entries = new Map([...pages].filter(([name, chunk]) => chunk.startsWith(`${name}-`)).map(([name, chunk]) => [chunk, name]));
  const loads = [...pages].map(([name, root]) => ({ name, chunks: reachable(graph, root) }));

  // Act
  const crossings = [...graph].flatMap(([chunk, imports]) =>
    imports
      .filter((imported) => entries.has(imported))
      .flatMap((entry) => loads.filter((p) => p.name !== entries.get(entry) && p.chunks.has(chunk)).map((p) => `${chunk} -> ${entry} (loads on ${p.name})`)),
  );

  // Assert
  expect([...entries.values()].sort()).toEqual(['join', 'pow-worker', 'watch']);
  expect([...graph.values()].flat().length).toBeGreaterThan(10);
  expect(crossings).toEqual([]);
});
