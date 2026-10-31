import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { fontLicenses } from '@swarmcast/shared/web/font-licenses';
import { startupGuard } from '@swarmcast/shared/web/startup-guard';
import { emojiDataPlugin } from './scripts/emoji-data.mjs';

// Multi-page build. No inline scripts are emitted but the startup guard (startupGuard writes it into
// join.html and watch.html), which the server allows by its hash: strict CSP, no 'unsafe-inline'.
export default defineConfig({
  plugins: [fontLicenses(), emojiDataPlugin(), startupGuard()],
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
