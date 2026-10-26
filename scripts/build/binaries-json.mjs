#!/usr/bin/env node
// Writes binaries.json: the pins (publisher URL, SHA-256, binary name, license) of the
// third-party tools SwarmCast does NOT ship ("bundle": false in versions.json, i.e. ffmpeg).
// The start scripts are standalone, so they read this release asset to download the tool
// for the user's OS/arch straight from its publisher and verify it.
//
// Usage: node scripts/build/binaries-json.mjs <out-file>
//
// Format: plain JSON, but each asset object is written on ONE line so the bash start scripts
// can read it without jq (grep the "<os>-<arch>" line inside the tool's block, then sed the
// fields). Keep it that way.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Render binaries.json from the parsed versions.json. */
export function renderBinariesJson(versions) {
  const lines = ['{', '  "schema": 1,', '  "note": "Downloaded by the start scripts from each publisher and verified with SHA-256; SwarmCast does not redistribute these tools.",'];
  const tools = Object.entries(versions).filter(([, spec]) => spec.bundle === false);
  tools.forEach(([tool, spec], ti) => {
    lines.push(`  ${JSON.stringify(tool)}: {`);
    lines.push(`    "version": ${JSON.stringify(spec.version)},`);
    lines.push(`    "license": ${JSON.stringify(spec.license)},`);
    lines.push('    "assets": {');
    const assets = Object.entries(spec.assets);
    assets.forEach(([target, a], ai) => {
      const url = a.url ?? spec.url.replace('{version}', spec.version).replace('{asset}', a.asset);
      if (!/^https:\/\//.test(url)) throw new Error(`${tool} ${target}: URL must be https (${url})`);
      if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`${tool} ${target}: bad sha256`);
      const obj = { url, asset: a.asset, sha256: a.sha256, binary: path.basename(a.binary), license: a.license ?? spec.license };
      lines.push(`      ${JSON.stringify(target)}: ${JSON.stringify(obj).replace(/","/g, '", "').replace(/":"/g, '": "')}${ai < assets.length - 1 ? ',' : ''}`);
    });
    lines.push('    }');
    lines.push(`  }${ti < tools.length - 1 ? ',' : ''}`);
  });
  lines.push('}');
  const out = lines.join('\n') + '\n';
  JSON.parse(out); // must stay valid JSON
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFile = process.argv[2];
  if (!outFile) {
    console.error('Usage: node scripts/build/binaries-json.mjs <out-file>');
    process.exit(2);
  }
  const versions = JSON.parse(fs.readFileSync(path.join(here, 'versions.json'), 'utf8'));
  fs.writeFileSync(outFile, renderBinariesJson(versions));
  console.log(`wrote ${outFile}`);
}
