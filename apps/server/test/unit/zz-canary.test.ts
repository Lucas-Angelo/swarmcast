import { expect, it } from 'vitest';

// WP1 CANARY (throwaway, reverted before the gate): a forced unit test failure.
it('WP1 canary: forced unit failure', () => {
  expect('canary').toBe('forced failure');
});
