// Runs the panel's "Install the video converter" flow (download, SHA-256 check, extract,
// `ffmpeg -version`) into a data directory, then probes the encoders with it.
//   node --import tsx scripts/test/quality/install-ffmpeg.ts <dataDir>
import { createLogger } from '../../../apps/server/src/core/logger.js';
import { probeEncoders } from '../../../apps/server/src/quality/encoders.js';
import { installFfmpeg } from '../../../apps/server/src/quality/ffmpeg.js';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: install-ffmpeg.ts <dataDir>');
const log = createLogger({ stdout: false });
let last = '';
const bin = await installFfmpeg(dataDir, log, (p) => {
  const line = `${p.phase} ${Math.round(p.receivedBytes / 1e6)} MB${p.message ? ` ${p.message}` : ''}`;
  if (p.phase !== 'downloading' || line !== last) console.log(line);
  last = line;
});
console.log(`installed: ${bin}`);
console.log(JSON.stringify(await probeEncoders({ ffmpeg: bin, reaper: null, log }), null, 1));
