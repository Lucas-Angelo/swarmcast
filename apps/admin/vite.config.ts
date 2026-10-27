import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fontLicenses } from '@swarmcast/shared/web/font-licenses';

export default defineConfig({
  plugins: [preact(), fontLicenses()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: {
      // gate.html is build-only: its hashed stylesheet + favicon links are read by the server for
      // the pages shown before the panel is open (apps/server/src/admin/gate.ts).
      input: { index: 'index.html', gate: 'gate.html' },
    },
  },
});
