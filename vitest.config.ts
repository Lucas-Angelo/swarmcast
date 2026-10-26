import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/test/unit/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
