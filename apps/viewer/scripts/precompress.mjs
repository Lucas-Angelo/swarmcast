// Pre-compressed copies of the viewer pages' scripts and styles (docs/QUALITY.md "Upload order").
//
// Every viewer downloads the watch page's scripts from the streamer's own computer, through her
// upload: about 1.1 MB as built, about 0.29 MB with Brotli. When many people join at once, those
// bytes share her uplink with the video of everyone already watching (the server's upload cap
// covers the video, not the page). The server serves `<file>.br` or `<file>.gz` next to each file
// to a browser that accepts it (@fastify/static `preCompressed`); Cloudflare's edge passes the
// encoding on, or decompresses for a client that does not take it.
//
// Vite plugin: in a production build, adds the .br (quality 11) and .gz (level 9) copies of every
// text asset of 1 KB or more under assets/ to the bundle itself, so they are part of the build's
// output (.github/scripts/no-dev-deps.mjs checks that dist is exactly that output).
import zlib from 'node:zlib';

/** Text assets worth compressing (images and fonts are compressed already). */
export const COMPRESSIBLE = /\.(js|mjs|css|svg|txt|json)$/;
const MIN_BYTES = 1024;

/** The compressed copies of `data`: Brotli at quality 11 and gzip at level 9 (both deterministic). */
export function compressedCopies(data) {
  return {
    br: zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
    gz: zlib.gzipSync(data, { level: 9 }),
  };
}

/** @returns {import('vite').Plugin} */
export function precompress() {
  return {
    name: 'swarmcast-precompress',
    apply: 'build',
    enforce: 'post',
    // Last of all: Vite's own build plugins still rewrite chunks in generateBundle (the preload
    // markers of dynamic imports); a copy made before them decodes to a script that does not run.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const [fileName, item] of Object.entries(bundle)) {
          if (!fileName.startsWith('assets/') || !COMPRESSIBLE.test(fileName)) continue;
          const data = Buffer.from(item.type === 'chunk' ? item.code : item.source);
          if (data.length < MIN_BYTES) continue;
          const { br, gz } = compressedCopies(data);
          this.emitFile({ type: 'asset', fileName: `${fileName}.br`, source: br });
          this.emitFile({ type: 'asset', fileName: `${fileName}.gz`, source: gz });
        }
      },
    },
  };
}
