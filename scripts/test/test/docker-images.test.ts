// scripts/test/docker/images.sh: the key and the names of the Docker suites' test images. A saved
// image is used only for exactly what it was built from (its Dockerfile, its pinned base and the
// architecture), so a change to any of them builds it again instead of testing an old image.
// The script runs in a copy of the folder (a temp folder with the same layout), so a test can
// change a Dockerfile; no Docker is needed (the platform is given). Bash scripts for Linux and
// macOS only, like the Docker suites: not run on Windows.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

const DOCKER_DIR = path.resolve(import.meta.dirname, '../docker');
const FILES = ['images.sh', 'pull.sh', 'build.sh', 'Dockerfile.appimage', 'Dockerfile.obs', 'Dockerfile.e2e', 'Dockerfile.webkit'];

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-images-test-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'scripts/test/docker');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, '.github/scripts'), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(DOCKER_DIR, f), path.join(dir, f));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.64.1' } } }));
});

/** `spec SPEC PLATFORM` of the copy, as its TI_* variables. */
function spec(name: string, platform = 'linux/amd64') {
  const script = `. scripts/test/docker/images.sh && spec "$1" "$2" && printf '%s\\n' "$TI_IMAGE" "$TI_BASE" "$TI_ARCH" "$TI_KEY" "$TI_FILE"`;
  const r = spawnSync('bash', ['-c', script, 'spec', name, platform], { cwd: root, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const [image, base, arch, key, file] = r.stdout.trim().split('\n');
  return { image, base, arch, key, file };
}

describe.skipIf(process.platform === 'win32')('images.sh', () => {
  it('builds each AppImage host from its base pinned by digest, named as the suites name it', () => {
    // Act
    const jammy = spec('appimage:ubuntu:22.04');

    // Assert
    expect(jammy.image).toBe('swarmcast-test-appimage:ubuntu-22.04-amd64');
    expect(jammy.base).toMatch(/^ubuntu:22\.04@sha256:[0-9a-f]{64}$/);
    expect(jammy.arch).toBe('x64');
    expect(jammy.file).toBe(`swarmcast-test-appimage-ubuntu-22.04-amd64-x64-${jammy.key}.tar.zst`);
  });

  it('gives every base, architecture and image its own key', () => {
    // Act
    const keys = [
      spec('appimage:ubuntu:22.04').key,
      spec('appimage:ubuntu:24.04').key,
      spec('appimage:debian:12').key,
      spec('appimage:ubuntu:22.04', 'linux/arm64').key,
      spec('obs').key,
    ];

    // Assert
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('changes the key when the Dockerfile changes', () => {
    // Arrange
    const before = spec('obs');
    fs.appendFileSync(path.join(root, 'scripts/test/docker/Dockerfile.obs'), 'ENV CHANGED=1\n');

    // Act
    const after = spec('obs');

    // Assert
    expect(after.key).not.toBe(before.key);
    expect(after.file).not.toBe(before.file);
  });

  it("takes the Playwright image of package-lock.json's version for the e2e image", () => {
    // Act
    const e2e = spec('e2e');

    // Assert
    expect(e2e.base).toBe('mcr.microsoft.com/playwright:v1.64.1-noble');
    expect(e2e.image).toBe('swarmcast-test-e2e:1.64.1-amd64');
  });

  it('names the artifact of a set of images the same whatever their order', () => {
    // Arrange
    const run = (...specs: string[]) =>
      spawnSync('bash', ['scripts/test/docker/images.sh', 'artifact', ...specs], { cwd: root, encoding: 'utf8' });

    // Act
    const a = run('appimage:ubuntu:22.04', 'appimage:ubuntu:24.04');
    const b = run('appimage:ubuntu:24.04', 'appimage:ubuntu:22.04');
    const one = run('appimage:ubuntu:22.04');

    // Assert
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toMatch(/^test-images-[a-z0-9]+-[0-9a-f]{16}\n$/);
    expect(b.stdout).toBe(a.stdout);
    expect(one.stdout).not.toBe(a.stdout);
  });
});
