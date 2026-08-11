import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTsc, parseTap, parseLines } from '../src/parsers.js';

const CWD = '/repo';

/** Drive-letter and backslash agnostic, so the same test runs on any OS. */
const norm = (p?: string) => (p ?? '').replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');

test('tsc parser extracts file, line, code and message', () => {
  const out = [
    'src/app.ts(2,10): error TS2307: Cannot find module \'./shipping-costs.js\' or its corresponding type declarations.',
    'src/pricing.ts(1,7): error TS6133: \'TAX_RATE\' is declared but its value is never read.',
  ].join('\n');
  const f = parseTsc(out, CWD, 'typecheck');

  assert.equal(f.length, 2);
  assert.equal(f[0].check, 'typecheck');
  assert.equal(norm(f[0].file), '/repo/src/app.ts');
  assert.equal(f[0].line, 2);
  assert.equal(f[0].code, 'TS2307');
  assert.equal(f[0].evidence.module, './shipping-costs.js');
  assert.equal(f[1].code, 'TS6133');
  assert.equal(f[1].evidence.symbol, 'TAX_RATE');
});

test('tsc parser extracts the member and module from TS2305', () => {
  const out = 'src/cart.ts(1,10): error TS2305: Module \'"./pricing.js"\' has no exported member \'lineTotal\'.';
  const [f] = parseTsc(out, CWD, 'typecheck');
  assert.equal(f.code, 'TS2305');
  assert.equal(f.evidence.member, 'lineTotal');
  assert.equal(f.evidence.module, './pricing.js');
});

test('tsc parser extracts the member from TS2459 (declared but not exported)', () => {
  const out = 'src/cart.ts(1,10): error TS2459: Module \'"./pricing.js"\' declares \'lineTotal\' locally, but it is not exported.';
  const [f] = parseTsc(out, CWD, 'typecheck');
  assert.equal(f.code, 'TS2459');
  assert.equal(f.evidence.member, 'lineTotal');
  assert.equal(f.evidence.module, './pricing.js');
});

test('tsc parser drops findings outside the source root', () => {
  const out = 'C:/Users/me/AppData/Roaming/npm/node_modules/x.ts(1,1): error TS1000: noise.';
  assert.equal(parseTsc(out, CWD, 'typecheck').length, 0);
});

test('tap parser handles per-file TAP blocks', () => {
  const out = [
    'TAP version 13',
    '# Subtest: test/pricing.test.ts',
    '    ok 1 - lineTotal multiplies quantity by price',
    '    not ok 2 - applyTax applies the 10% tax rate',
    '      ---',
    '      error: AssertionError [ERR_ASSERTION]: expected 8 to equal 10',
    '          at file:///repo/test/pricing.test.ts:13:10',
    '      ...',
    '    1..2',
    'ok 1 - test/pricing.test.ts',
    '1..1',
  ].join('\n');
  const f = parseTap(out, CWD, 'test');

  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'blocker');
  assert.equal(f[0].summary, 'applyTax applies the 10% tax rate');
  assert.equal(norm(f[0].file), '/repo/test/pricing.test.ts');
  assert.equal(f[0].line, 13);
});

test('tap parser reads the location field when there is no stack line', () => {
  const out = [
    'not ok 1 - applyTax applies the 10% tax rate',
    '  ---',
    "  location: 'C:/repo/test/pricing.test.ts:6:1'",
    '  failureType: testCodeFailure',
    '  ...',
  ].join('\n');
  const [f] = parseTap(out, CWD, 'test');
  assert.equal(f.summary, 'applyTax applies the 10% tax rate');
  assert.equal(norm(f.file), '/repo/test/pricing.test.ts');
  assert.equal(f.line, 6);
});

test('lines parser separates file-prefixed lines from plain messages', () => {
  const out = [
    'README.md: version 0.1.0 does not match 0.2.0 in package.json',
    'version-drift: no release channel declared',
  ].join('\n');
  const f = parseLines(out, CWD, 'version');

  assert.equal(f.length, 2);
  assert.equal(norm(f[0].file), '/repo/README.md');
  assert.ok(f[0].summary.includes('0.1.0'));
  assert.equal(f[1].file, undefined);
  assert.ok(f[1].summary.includes('release channel'));
});

test('fingerprints are stable across numbers but differ by defect', () => {
  const a = parseTsc('src/a.ts(1,1): error TS2307: Cannot find module \'./x\'.', CWD, 'typecheck');
  const b = parseTsc('src/a.ts(9,9): error TS2307: Cannot find module \'./x\'.', CWD, 'typecheck');
  const c = parseTsc('src/a.ts(1,1): error TS2307: Cannot find module \'./y\'.', CWD, 'typecheck');
  assert.equal(a[0].fingerprint, b[0].fingerprint);
  assert.notEqual(a[0].fingerprint, c[0].fingerprint);
});
