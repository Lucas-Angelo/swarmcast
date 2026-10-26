import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Multi-page build. No inline scripts are emitted, so the strict CSP (script-src 'self') holds.
export default defineConfig({
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
