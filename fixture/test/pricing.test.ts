import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTax } from '../src/pricing.js';

// The planted defect: applyTax hardcodes 8%, the contract says 10%.
test('applyTax applies the 10% tax rate', () => {
  assert.equal(applyTax(100), 10);
});
