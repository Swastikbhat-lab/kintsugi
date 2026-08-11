import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateShipping } from '../src/shipping.js';

// The control: must stay passing for the whole run. Any "fix" that breaks
// this is collateral damage and must be reverted.
test('shipping stays within the basic tier for light parcels', () => {
  assert.equal(calculateShipping(2), 4.99);
});
