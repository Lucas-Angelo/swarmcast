import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['.claude/**', 'apps/server/shims/**', '**/dist/**', '**/build/**', 'release/**', 'vendor/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'apps/tray/**', 'site/.astro/**', 'site/node_modules/**', 'site/playwright-report/**', 'site/test-results/**', 'apps/desktop/src-tauri/target/**', 'apps/desktop/src-tauri/staged/**', 'apps/desktop/src-tauri/gen/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
