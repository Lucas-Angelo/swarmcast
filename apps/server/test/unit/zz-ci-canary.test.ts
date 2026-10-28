import { expect, test } from 'vitest';

// Throwaway canary (WP9): ci-ok must turn red when a stage fails. Reverted right after.
test('ci-ok canary', () => {
  expect(1 + 1).toBe(3);
});
