import { defineConfig } from 'vitest/config';

/**
 * Files whose ffmpeg work (the quality ladder encodes 720p and 480p in real time) needs the
 * machine to itself: they run alone, after every other file.
 */
const MEDIA = ['apps/server/test/integration/ladder.test.ts'];

const shared = {
  environment: 'node',
  testTimeout: 120_000,
  hookTimeout: 120_000,
  // Every test file gets its own ports (scripts/test/lib/ports.mjs: one block per worker) and
  // its own processes, data folder and HOME, so files can run side by side.
  isolate: true,
} as const;

export default defineConfig({
  test: {
    globalSetup: ['apps/server/test/integration/global-setup.ts'],
    // A machine-readable result per run (CI uploads it with test-results/), plus annotations on
    // GitHub, which Vitest adds by itself only when no reporters are configured.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions', 'json'] : ['default', 'json'],
    outputFile: { json: 'test-results/vitest-integration.json' },
    projects: [
      {
        test: {
          ...shared,
          name: 'integration',
          include: ['apps/server/test/integration/**/*.test.ts'],
          exclude: MEDIA,
          // Light files (a copied feed, servers, subprocesses): three at a time.
          maxWorkers: 3,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...shared,
          name: 'integration-media',
          include: MEDIA,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
