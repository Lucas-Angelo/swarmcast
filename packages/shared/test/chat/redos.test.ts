import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P13 (plan §6.5): no regex in the chat code can backtrack badly. Every regex literal under
 * packages/shared/src/chat and apps/server/src/chat must be linear by construction: no
 * quantified group and at most one variable quantifier (exact counts like {8} are fine). User input
 * is never turned into a regex.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DIRS = ['packages/shared/src/chat', 'packages/shared/src/branding', 'apps/server/src/chat', 'apps/server/src/branding'];

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

/** What the linear-by-construction rule finds wrong in a regex literal, if anything. */
function redosRisks(lit: string): string[] {
  const body = lit.slice(1, lit.lastIndexOf('/')).replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'C');
  const risks: string[] = [];
  if (/\)[*+?{]/.test(body)) risks.push(`${lit}: quantified group`);
  if ((body.match(/[*+?]|\{\d+,/g) ?? []).length > 1) risks.push(`${lit}: more than one variable quantifier`);
  return risks;
}

const FILES = DIRS.flatMap((d) =>
  (fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)) : [])
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.generated.ts'))
    .map((f) => path.join(root, d, f)),
);

describe('chat regexes are ReDoS-safe', () => {
  it('finds the chat sources', () => {
    // Act
    const all = FILES.flatMap((f) => regexLiterals(fs.readFileSync(f, 'utf8')));
    // Assert
    expect(FILES.length).toBeGreaterThan(8);
    expect(all.length).toBeGreaterThan(20);
    expect(all).toContain('/^[A-Za-z0-9_-]{1,64}$/');
  });

  it.each(FILES.map((f) => [path.relative(root, f), f]))('%s', (_name, file) => {
    // Act
    const risks = regexLiterals(fs.readFileSync(file, 'utf8')).flatMap(redosRisks);
    // Assert
    expect(risks).toEqual([]);
  });
});
