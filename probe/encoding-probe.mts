// Temporary probe: which way of reading ONE Run value by name returns its exact Unicode data?
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'ScEncodingProbe';
const DATA = '"C:\\Users\\João Ñandú 日本 😀 %USERPROFILE% & ^ !x!\\App  Data\\SwarmCast.exe" --background';

function exec(command: string, args: string[], extra: object = {}): Promise<{ code: number; stdout: Buffer; stderr: string; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 30_000, encoding: 'buffer', ...extra }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: stdout as Buffer, stderr: String(stderr), ms: Math.round(performance.now() - t0) });
    });
  });
}

function check(label: string, got: string | null, ms: number, extra = ''): void {
  console.log(`${got === DATA ? 'EXACT ' : 'WRONG '} ${label} (${ms} ms) ${got === DATA ? '' : JSON.stringify(got)} ${extra}`);
}

const add = await exec('reg.exe', ['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', DATA, '/f']);
console.log(`reg add exit ${add.code} ${add.stderr}`);

// a) reg query, plain pipe
for (let i = 0; i < 2; i++) {
  const q = await exec('reg.exe', ['query', KEY, '/v', NAME]);
  const line = q.stdout.toString('latin1').split(/\r?\n/).find((l) => l.includes(NAME)) ?? '';
  const m = /REG_SZ {4}(.*)$/.exec(q.stdout.toString('utf8').split(/\r?\n/).find((l) => l.includes(NAME)) ?? '');
  check(`reg query (utf8 decode) exit ${q.code}`, m ? m[1]! : null, q.ms, `raw: ${Buffer.from(line, 'latin1').toString('hex').slice(0, 400)}`);
}
// b) chcp 65001 then reg query, one cmd
for (let i = 0; i < 2; i++) {
  const q = await exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"chcp 65001 >nul & reg.exe query "${KEY}" /v ${NAME}"`], { windowsVerbatimArguments: true });
  const m = /REG_SZ {4}(.*)$/.exec(q.stdout.toString('utf8').split(/\r?\n/).find((l) => l.includes(NAME)) ?? '');
  check(`chcp 65001 + reg query exit ${q.code}`, m ? m[1]! : null, q.ms);
}
// c) PowerShell, base64 of the UTF-16 data
for (let i = 0; i < 3; i++) {
  const script = `$ErrorActionPreference='Stop'; $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run'); $v=$k.GetValue('${NAME}', $null, 'DoNotExpandEnvironmentNames'); if ($null -eq $v) { 'none' } else { $k.GetValueKind('${NAME}').ToString() + ':' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$v)) }`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const q = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  const out = q.stdout.toString('utf8').trim();
  const b64 = out.split(':')[1];
  check(`powershell base64 exit ${q.code} kind ${out.split(':')[0]}`, b64 ? Buffer.from(b64, 'base64').toString('utf16le') : null, q.ms, q.stderr.slice(0, 300));
}
// d) reg export (baseline)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-'));
const e = await exec('reg.exe', ['export', KEY, path.join(dir, 'r.reg'), '/y']);
const text = fs.readFileSync(path.join(dir, 'r.reg')).subarray(2).toString('utf16le');
const line = text.split(/\r?\n/).find((l) => l.startsWith(`"${NAME}"=`)) ?? '';
let out = '';
const raw = line.slice(NAME.length + 3);
for (let j = 1; j < raw.length; j++) {
  const ch = raw[j]!;
  if (ch === '\\' && j + 1 < raw.length) out += raw[++j];
  else if (ch === '"') break;
  else out += ch;
}
check(`reg export exit ${e.code}`, out, e.ms);
// e) missing value: exit codes and stderr of each method
const miss = await exec('reg.exe', ['query', KEY, '/v', 'ScNoSuchValue']);
console.log(`reg query of a missing value: exit ${miss.code} stdout ${JSON.stringify(miss.stdout.toString('utf8'))} stderr ${JSON.stringify(miss.stderr)}`);
const missKey = await exec('reg.exe', ['query', 'HKCU\\Software\\ScNoSuchKey', '/v', 'x']);
console.log(`reg query of a missing key: exit ${missKey.code} stderr ${JSON.stringify(missKey.stderr)}`);
await exec('reg.exe', ['delete', KEY, '/v', NAME, '/f']);
