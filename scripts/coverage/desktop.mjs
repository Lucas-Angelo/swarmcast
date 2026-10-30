// Coverage of the desktop shell's Rust tests (docs/DEVELOPMENT.md, "Coverage").
//
//   node scripts/coverage/desktop.mjs [cargo test arguments...]   (npm run coverage:desktop)
//
// Runs `cargo test --locked` in apps/desktop/src-tauri (its rust-toolchain.toml applies) under
// cargo-llvm-cov: rustc's source-based coverage (-C instrument-coverage), so each OS measures the
// cfg(target_os) code it compiles. Writes coverage/desktop/lcov.info and llvm-summary.json (the
// totals report.mjs reads) and prints the per-file table. Needs cargo-llvm-cov and the llvm-tools
// rustup component (`cargo install cargo-llvm-cov --locked`, `rustup component add llvm-tools`).
// The instrumented build has its own folder, target/llvm-cov-target, next to the normal one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CRATE = path.join(ROOT, 'apps/desktop/src-tauri');
const OUT = path.join(ROOT, 'coverage', 'desktop');

const llvmCov = (...args) => execFileSync('cargo', ['llvm-cov', ...args], { cwd: CRATE, stdio: 'inherit' });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
// The profiles of an earlier run must not count: clean them (and the crate's own instrumented
// build; the dependencies stay), run the tests once, then make every report from those profiles.
llvmCov('clean', '--workspace');
llvmCov('--no-report', '--locked', ...process.argv.slice(2));
llvmCov('report', '--lcov', '--output-path', path.join(OUT, 'lcov.info'));
llvmCov('report', '--json', '--summary-only', '--output-path', path.join(OUT, 'llvm-summary.json'));
llvmCov('report');
