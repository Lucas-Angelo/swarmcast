// Pre-compressed copies of the viewer pages' scripts and styles (docs/QUALITY.md "Upload order").
//
// Every viewer downloads the watch page's scripts from the streamer's own computer, through her
// upload: about 1.1 MB as built, about 0.29 MB with Brotli. When many people join at once, those
// bytes share her uplink with the video of everyone already watching (the server's upload cap
// covers the video, not the page). The server serves `<file>.br` or `<file>.gz` next to each file
// to a browser that accepts it (@fastify/static `preCompressed`); Cloudflare's edge passes the
// encoding on, or decompresses for a client that does not take it.
//
// Vite plugin: after a production build, writes the .br (quality 11) and .gz (level 9) copies of
// every text asset of 1 KB or more in dist/assets.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Text assets worth compressing (images and fonts are compressed already). */
export const COMPRESSIBLE = /\.(js|mjs|css|svg|txt|json)$/;
const MIN_BYTES = 1024;

/** Writes the compressed copies of every compressible file in `dir`; returns { files, raw, br, gz } bytes. */
export function precompressDir(dir) {
  const out = { files: 0, raw: 0, br: 0, gz: 0 };
  for (const name of fs.readdirSync(dir)) {
    if (!COMPRESSIBLE.test(name)) continue;
    const file = path.join(dir, name);
    const data = fs.readFileSync(file);
    if (data.length < MIN_BYTES) continue;
    const br = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    const gz = zlib.gzipSync(data, { level: 9 });
    fs.writeFileSync(`${file}.br`, br);
    fs.writeFileSync(`${file}.gz`, gz);
    out.files += 1;
    out.raw += data.length;
    out.br += br.length;
    out.gz += gz.length;
  }
  return out;
}

/** @returns {import('vite').Plugin} */
export function precompress() {
  let outDir = 'dist';
  return {
    name: 'swarmcast-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const assets = path.join(outDir, 'assets');
      if (fs.existsSync(assets)) precompressDir(assets);
    },
  };
}
