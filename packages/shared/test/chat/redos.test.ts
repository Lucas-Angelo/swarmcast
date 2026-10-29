import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P13 (plan §6.5): no regex in the chat code can backtrack badly. Every regex literal under
 * packages/shared/src/chat and apps/server/src/chat must be linear by construction: no
 * quantified group and at most one quantifier. User input is never turned into a regex.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DIRS = ['packages/shared/src/chat', 'apps/server/src/chat'];

function regexLiterals(src: string): string[] {
  const out: string[] = [];
  // A "/" starts a regex after these tokens (not after an identifier, number or ")").
  const re = /(?:^|[=(,:[!&|?{};]|return)\s*(\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuvy]*)/g;
  for (const line of src.split('\n')) {
    const code = line.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    for (const m of code.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

describe('chat regexes are ReDoS-safe', () => {
  const files = DIRS.flatMap((d) =>
    fs
      .readdirSync(path.join(root, d))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.generated.ts'))
      .map((f) => path.join(root, d, f)),
  );

  it('finds the chat sources', () => {
    expect(files.length).toBeGreaterThan(8);
    const all = files.flatMap((f) => regexLiterals(fs.readFileSync(f, 'utf8')));
    expect(all.length).toBeGreaterThan(20);
    expect(all).toContain('/^[A-Za-z0-9_-]{1,64}$/');
  });

  for (const file of files) {
    it(path.relative(root, file), () => {
      for (const lit of regexLiterals(fs.readFileSync(file, 'utf8'))) {
        const body = lit.slice(1, lit.lastIndexOf('/')).replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'C');
        expect(/\)[*+?{]/.test(body), `${lit}: quantified group`).toBe(false);
        expect((body.match(/[*+?]|\{\d/g) ?? []).length, `${lit}: more than one quantifier`).toBeLessThanOrEqual(1);
      }
    });
  }
});
