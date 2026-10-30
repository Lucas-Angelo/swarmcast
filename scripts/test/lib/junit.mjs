// JUnit XML from a system harness's own results, for the CI summary (`node
// .github/scripts/test-summary.mjs --junit <file>`) and any JUnit reader: one testsuite, one
// testcase per check. The harness keeps its own output and exit code; this is a second view.
import fs from 'node:fs';
import path from 'node:path';

/** Text safe in XML 1.0: the five entities escaped, control characters XML forbids dropped. */
// eslint-disable-next-line no-control-regex
const xml = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/**
 * The JUnit document of `cases`: `status` 'fail' is a <failure> (its `detail` the message),
 * 'skip' a <skipped>, anything else passed ('warn': a finding that does not fail the run, kept as
 * system-out). `group` becomes the classname (a section, a scenario).
 * @param {string} suite
 * @param {Array<{ group?: string, name: string, status: string, detail?: string, seconds?: number }>} cases
 */
export function junitXml(suite, cases) {
  const failures = cases.filter((c) => c.status === 'fail').length;
  const skipped = cases.filter((c) => c.status === 'skip').length;
  const body = cases.map((c) => {
    const head = `    <testcase classname="${xml(c.group ?? suite)}" name="${xml(c.name)}" time="${(c.seconds ?? 0).toFixed(3)}"`;
    if (c.status === 'fail') return `${head}>\n      <failure message="${xml(String(c.detail ?? '').split('\n')[0].slice(0, 500))}">${xml(c.detail)}</failure>\n    </testcase>`;
    if (c.status === 'skip') return `${head}>\n      <skipped message="${xml(c.detail)}"/>\n    </testcase>`;
    if (c.status === 'warn') return `${head}>\n      <system-out>${xml(`WARN: ${c.detail ?? ''}`)}</system-out>\n    </testcase>`;
    return `${head}/>`;
  });
  return ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="${xml(suite)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">`, `  <testsuite name="${xml(suite)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">`, ...body, '  </testsuite>', '</testsuites>', ''].join('\n');
}

/** Writes junitXml(suite, cases) to `file` (its folder created). */
export function writeJunit(file, suite, cases) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, junitXml(suite, cases));
}
