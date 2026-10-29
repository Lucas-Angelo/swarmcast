import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/test/unit/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'scripts/*/test/**/*.test.ts', 'site/test/unit/**/*.test.ts'],
    environment: 'node',
    // A machine-readable result per run (CI uploads it with test-results/), plus annotations on
    // GitHub, which Vitest adds by itself only when no reporters are configured.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions', 'json'] : ['default', 'json'],
    outputFile: { json: 'test-results/vitest-unit.json' },
    testTimeout: 15_000,
  },
});
