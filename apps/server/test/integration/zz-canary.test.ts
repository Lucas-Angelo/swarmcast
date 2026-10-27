import { once } from 'node:events';
import { expect, it } from 'vitest';
import { pushTestStream } from './helpers.js';

// WP1 CANARY (throwaway, reverted before the gate): a fake OBS that dies at once (its stderr
// lands in test-results/fake-obs.log), then a forced failure.
it('WP1 canary: dead fake OBS and a forced integration failure', async () => {
  const child = pushTestStream('rtmp://127.0.0.1:9/live/canary', { size: 'bogus' });
  const [code] = await once(child, 'exit');
  expect(code, 'fake OBS exit code (see fake-obs.log)').toBe(0);
});
