import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import type { Finding, Patch } from '../src/types.js';

const fp = 'deadbeef';

function patch(find: string, replace: string): Patch {
  return { id: 'p', file: '/repo/src/a.ts', find, replace, rationale: 'r', scope: 'local' };
}

const finding: Finding = {
  fingerprint: fp,
  check: 'typecheck',
  severity: 'major',
  summary: 'x',
  file: '/repo/src/a.ts',
  code: 'TS1',
  evidence: {},
};

function ledger(): Ledger {
  return new Ledger(join(mkdtempSync(join(tmpdir(), 'kintsugi-ledger-')), 'ledger.json'));
}

test('a failed attempt makes the identical patch untriable again', () => {
  const l = ledger();
  assert.equal(l.shouldTry(fp, patch('a', 'b')), true);
  l.record({ fingerprint: fp, patch: patch('a', 'b'), outcome: 'ineffective', at: 't', collateral: [] });
  assert.equal(l.shouldTry(fp, patch('a', 'b')), false);
  // A different replacement is still worth trying.
  assert.equal(l.shouldTry(fp, patch('a', 'c')), true);
});

test('a committed patch is prioritised on the next encounter', () => {
  const l = ledger();
  l.record({ fingerprint: fp, patch: patch('a', 'b'), outcome: 'committed', at: 't', collateral: [] });
  const ordered = l.prioritise(fp, [patch('a', 'c'), patch('a', 'b')]);
  assert.equal(ordered[0].replace, 'b');
});

test('a finding with no candidate patches is quarantined immediately (model-backed)', () => {
  const l = ledger();
  l.record({
    fingerprint: fp,
    patch: { id: 'none', file: '', find: '', replace: '', rationale: 'no candidate', scope: 'local' },
    outcome: 'unverifiable',
    at: 't',
    collateral: [],
    provider: true,
  });
  assert.equal(l.isExhausted(finding), true);
});

test('a rules-only dead end never blinds a later model run', () => {
  const l = ledger();
  // Rules-only run: no provider, so `patch.id === 'none'` is recorded without
  // the provider flag — the finding must stay actionable for a future run
  // that has a model configured.
  l.record({
    fingerprint: fp,
    patch: { id: 'none', file: '', find: '', replace: '', rationale: 'no candidate', scope: 'local' },
    outcome: 'unverifiable',
    at: 't',
    collateral: [],
  });
  assert.equal(l.isExhausted(finding), false);
});

test('repeated failures exhaust a finding', () => {
  const l = ledger();
  for (let i = 0; i < 3; i++) {
    l.record({ fingerprint: fp, patch: patch(`a${i}`, 'b'), outcome: 'ineffective', at: 't', collateral: [] });
  }
  assert.equal(l.isExhausted(finding), true);
});
