// Prints what the encoder probe finds on this PC (the same 1-second test the app runs).
//   node --import tsx scripts/test/quality/probe-encoders.ts [path/to/ffmpeg]
import { createLogger } from '../../../apps/server/src/core/logger.js';
import { cpuCores, probeEncoders } from '../../../apps/server/src/quality/encoders.js';

const log = createLogger({ stdout: false });
const results = await probeEncoders({ ffmpeg: process.argv[2] ?? 'ffmpeg', reaper: null, log });
console.log(JSON.stringify({ cpuCores: cpuCores(), results }, null, 2));
