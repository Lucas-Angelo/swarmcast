import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { fontLicenses } from '@swarmcast/shared/web/font-licenses';

// Multi-page build. No inline scripts are emitted, so the strict CSP (script-src 'self') holds.
export default defineConfig({
  plugins: [fontLicenses()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['es2022', 'safari16'],
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        join: resolve(__dirname, 'join.html'),
        watch: resolve(__dirname, 'watch.html'),
        invalid: resolve(__dirname, 'invalid.html'),
      },
    },
  },
});
