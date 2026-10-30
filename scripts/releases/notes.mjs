#!/usr/bin/env node
// Prints one section of CHANGELOG.md: the release notes (release page, latest.json, the
// desktop app's update dialog).
//
//   node scripts/releases/notes.mjs --section 0.3.0 CHANGELOG.md     (a stable release)
//   node scripts/releases/notes.mjs --section Unreleased CHANGELOG.md (a pre-release)
//
// The section runs from its `## [name]` heading to the next `## [` heading or the link
// references at the bottom. Missing or empty: exit 1 with a ::error:: line.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The body of `## [section]` (trimmed), or null when the heading is missing. */
export function changelogSection(text, section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `## [${section}]` || l.startsWith(`## [${section}] `));
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## [') || /^\[[^\]]+\]: /.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--section');
  const section = i >= 0 ? args[i + 1] : undefined;
  const file = args.filter((a, j) => j !== i && j !== i + 1)[0];
  if (!section || !file) {
    console.error('usage: notes.mjs --section <name> CHANGELOG.md');
    process.exit(2);
  }
  const notes = changelogSection(fs.readFileSync(file, 'utf8'), section);
  if (!notes) {
    console.error(`::error file=${file}::${notes === null ? `No '## [${section}]' section` : `The '## [${section}]' section is empty`} in ${file}: it becomes the release notes and the update dialog.`);
    process.exit(1);
  }
  process.stdout.write(`${notes}\n`);
}
