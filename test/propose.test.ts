import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { proposePatches } from '../src/propose.js';
import { copyFixture } from './helpers.js';
import type { Finding } from '../src/types.js';

function finding(over: Partial<Finding>): Finding {
  return {
    fingerprint: 'f',
    check: 'typecheck',
    severity: 'major',
    summary: 's',
    code: 'TS1',
    evidence: {},
    ...over,
  };
}

test('TS2307: rewrites an unresolvable import path to the real module', async () => {
  const root = copyFixture();
  const file = resolve(root, 'src/app.ts');
  const [p] = await proposePatches(finding({
    file,
    code: 'TS2307',
    evidence: { module: './shipping-costs.js' },
  }), root);

  assert.ok(p);
  assert.equal(p.find, "'./shipping-costs.js'");
  // The original wrote an extension, so the repair keeps the NodeNext
  // convention and maps the source file's .ts to .js.
  assert.equal(p.replace, "'./shipping.js'");
  assert.ok(readFileSync(file, 'utf8').includes(p.find));
});

test('TS2305: adds export when the declaration exists', async () => {
  const root = copyFixture();
  const [p] = await proposePatches(finding({
    file: resolve(root, 'src/cart.ts'),
    code: 'TS2305',
    evidence: { member: 'lineTotal', module: resolve(root, 'src/pricing.ts') },
  }), root);

  assert.ok(p);
  assert.match(p.replace, /^export function lineTotal/);
  assert.ok(readFileSync(p.file, 'utf8').includes('function lineTotal'));
});

test('TS2305: no rule when the declaration does not exist anywhere', async () => {
  const root = copyFixture();
  const patches = await proposePatches(finding({
    file: resolve(root, 'src/app.ts'),
    code: 'TS2305',
    evidence: { member: 'loadConfig', module: resolve(root, 'src/config.ts') },
  }), root);
  assert.deepEqual(patches, []);
});

test('TS6133: removes a dead statement-level declaration', async () => {
  const root = copyFixture();
  const file = resolve(root, 'src/pricing.ts');
  const before = readFileSync(file, 'utf8');
  const [p] = await proposePatches(finding({
    file,
    code: 'TS6133',
    evidence: { symbol: 'TAX_RATE' },
  }), root);

  assert.ok(p);
  assert.ok(p.find.includes('const TAX_RATE = 0.08;'));
  const after = before.replace(p.find, p.replace);
  assert.ok(!after.includes('const TAX_RATE'));
});

test('version drift: stale README version is replaced from package.json', async () => {
  const root = copyFixture();
  const [p] = await proposePatches(finding({
    file: resolve(root, 'README.md'),
    check: 'version',
    severity: 'minor',
    evidence: { message: 'README.md: version 0.1.0 does not match 0.2.0 in package.json' },
  }), root);

  assert.ok(p);
  assert.match(p.replace, /Version 0\.2\.0/);
});
