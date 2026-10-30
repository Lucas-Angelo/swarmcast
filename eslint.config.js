import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['.claude/**', 'apps/server/shims/**', '**/dist/**', '**/build/**', '!scripts/build/**', 'release/**', 'vendor/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'apps/tray/**', 'site/.astro/**', 'site/node_modules/**', 'site/playwright-report/**', 'site/test-results/**', 'apps/desktop/src-tauri/target/**', 'apps/desktop/src-tauri/staged/**', 'apps/desktop/src-tauri/gen/**'],
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
  {
    // Chat and the streamer's page render untrusted text: DOM only through createElement + textContent (plan §2.4.1).
    files: ['apps/viewer/src/chat/**', 'apps/admin/src/chat/**', 'apps/viewer/src/branding/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Chat: use textContent / createElement, never innerHTML.' },
        { property: 'outerHTML', message: 'Chat: use textContent / createElement, never outerHTML.' },
        { property: 'insertAdjacentHTML', message: 'Chat: use textContent / createElement.' },
        { property: 'createContextualFragment', message: 'Chat: use textContent / createElement.' },
        { object: 'document', property: 'write', message: 'Chat: never document.write.' },
        { object: 'document', property: 'writeln', message: 'Chat: never document.writeln.' },
      ],
      'no-restricted-globals': ['error', { name: 'DOMParser', message: 'Chat: never parse markup.' }],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name='setAttribute'][arguments.0.value='style']", message: 'Chat: set colours with style.setProperty (CSP blocks style attributes).' },
        { selector: "MemberExpression[property.name='cssText']", message: 'Chat: set colours with style.setProperty (CSP blocks cssText).' },
        { selector: "Literal[regex.flags=/v/]", message: 'Chat: no v-flag regex literals in viewer code (Safari 16 cannot parse them); build with new RegExp at first use.' },
      ],
    },
  },
  // ---- panel: chat + branding (lane C) ----
  {
    // The panel renders viewer text (chat) and streamer text (branding): Preact text nodes only.
    files: ['apps/admin/src/chat/**', 'apps/admin/src/branding/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Panel chat/branding: use text nodes, never innerHTML.' },
        { property: 'outerHTML', message: 'Panel chat/branding: use text nodes, never outerHTML.' },
        { property: 'insertAdjacentHTML', message: 'Panel chat/branding: use text nodes.' },
        { property: 'createContextualFragment', message: 'Panel chat/branding: use text nodes.' },
        { object: 'document', property: 'write', message: 'Never document.write.' },
        { object: 'document', property: 'writeln', message: 'Never document.writeln.' },
      ],
      'no-restricted-globals': ['error', { name: 'DOMParser', message: 'Never parse markup.' }],
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Never dangerouslySetInnerHTML.' },
        { selector: "Property[key.name='dangerouslySetInnerHTML']", message: 'Never dangerouslySetInnerHTML.' },
        { selector: "MemberExpression[property.name='cssText']", message: 'Set colours with style.setProperty (CSP).' },
      ],
    },
  },
  // ---- end ----
);
