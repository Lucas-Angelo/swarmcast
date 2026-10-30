import { defineConfig } from 'vitest/config';
import floors from './scripts/coverage/floors.json' with { type: 'json' };

/**
 * Files whose ffmpeg work (the quality ladder encodes 720p and 480p in real time) needs the
 * machine to itself: they run alone, after every other file.
 */
const MEDIA = ['apps/server/test/integration/ladder.test.ts'];

/**
 * Coverage floors of this OS (scripts/coverage/floors.json): the files that run differ per OS
 * (the ACME test needs Docker, which only the Linux runners have; Windows skips the POSIX-signal
 * lifecycle and desktop-mode files). An OS without floors only reports.
 */
const coverageFloors = (floors.integration as Record<string, { total?: Record<string, number> }>)[process.platform]?.total;

const shared = {
  environment: 'node',
  testTimeout: 120_000,
  hookTimeout: 120_000,
  // Every test file gets its own ports (scripts/test/lib/ports.mjs: one block per worker) and
  // its own processes, data folder and HOME, so files can run side by side.
  isolate: true,
  // A test passes on its first run or it has a bug to fix: never re-run a failed test.
  retry: 0,
} as const;

export default defineConfig({
  test: {
    globalSetup: ['apps/server/test/integration/global-setup.ts'],
    // A machine-readable result per run (CI uploads it with test-results/), plus annotations on
    // GitHub, which Vitest adds by itself only when no reporters are configured.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions', 'json'] : ['default', 'json'],
    outputFile: { json: 'test-results/vitest-integration.json' },
    // `npm run coverage:integration` (`--coverage`): the server and shared code the tests run in
    // this process (createApp, bootApp). A SwarmCast they start as a child runs the bundle, which
    // has no source map, so its own run is not counted (docs/DEVELOPMENT.md, "Coverage").
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/integration',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['apps/server/src/**/*.ts', 'packages/shared/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.generated.ts'],
      ...(coverageFloors ? { thresholds: coverageFloors } : {}),
    },
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
