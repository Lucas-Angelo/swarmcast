import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/server/test/integration/**/*.test.ts'],
    globalSetup: ['apps/server/test/integration/global-setup.ts'],
    environment: 'node',
    // A machine-readable result per run (CI uploads it with test-results/), plus annotations on
    // GitHub, which Vitest adds by itself only when no reporters are configured.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions', 'json'] : ['default', 'json'],
    outputFile: { json: 'test-results/vitest-integration.json' },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
