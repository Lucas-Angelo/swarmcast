import { defineConfig } from 'vitest/config';
import floors from './scripts/coverage/floors.json' with { type: 'json' };

/**
 * Coverage floors of the unit run (scripts/coverage/floors.json, the same on every OS): the whole
 * run, and each area by its path prefix. They only go up (docs/DEVELOPMENT.md, "Coverage").
 */
const { total, ...areas } = (floors.unit as Record<string, Record<string, Record<string, number>>>)['*'] ?? {};

export default defineConfig({
  test: {
    include: ['apps/*/test/unit/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'scripts/*/test/**/*.test.ts', 'site/test/unit/**/*.test.ts'],
    environment: 'node',
    // A machine-readable result per run (CI uploads it with test-results/), plus annotations on
    // GitHub, which Vitest adds by itself only when no reporters are configured.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions', 'json'] : ['default', 'json'],
    outputFile: { json: 'test-results/vitest-unit.json' },
    testTimeout: 15_000,
    // A test passes on its first run or it has a bug to fix: never re-run a failed test.
    retry: 0,
    // `npm run coverage:unit` (`vitest run --coverage`). Every source file counts, also those no
    // test loads: the apps, the shared package, the build, release, stats and coverage scripts and
    // the website's own scripts. Not counted: tests and their helpers, type declarations, the
    // generated Unicode tables, configs and the test harness (scripts/test, scripts/ci).
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: [
        'apps/server/src/**/*.ts',
        'apps/viewer/src/**/*.ts',
        'apps/admin/src/**/*.{ts,tsx}',
        'packages/shared/src/**/*.ts',
        'packages/shared/web/**/*.mjs',
        'scripts/{build,coverage,releases,stats}/**/*.mjs',
        'site/src/**/*.{ts,mjs}',
      ],
      exclude: ['**/test/**', '**/*.d.ts', '**/*.d.mts', '**/*.generated.ts'],
      thresholds: { ...total, ...Object.fromEntries(Object.entries(areas).map(([prefix, floor]) => [`${prefix}**`, floor])) },
    },
  },
});
