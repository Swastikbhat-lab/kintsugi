import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditTrace, printAudit } from '../src/audit.js';
import { costUsd } from '../src/tracer.js';

function fakeClient(records: unknown[]) {
  return {
    api: {
      _observations: {
        async getMany() {
          return { data: records };
        },
      },
    },
  };
}

test('auditTrace joins generation usage to settle-span attempts by fingerprint', async () => {
  const records = [
    {
      name: 'settle', type: 'SPAN',
      input: {
        status: 'converged', iterations: 3,
        attempts: [
          { fingerprint: 'fpA', check: 'py:bandit', outcome: 'committed', patch: { file: 'a.py', rationale: 'move secret to env' }, provider: false, collateral: [], at: 't' },
          { fingerprint: 'fpB', check: 'py:test', outcome: 'quarantined', patch: { file: 'b.py', rationale: 'no rule' }, provider: false, collateral: [], at: 't' },
        ],
      },
    },
    { name: 'propose', type: 'GENERATION', input: { fingerprint: 'fpA', check: 'py:bandit', candidates: 1 }, usage: { input: 1000, output: 500 } },
    { name: 'propose', type: 'GENERATION', input: { fingerprint: 'fpA', check: 'py:bandit', candidates: 2 }, usage: { input: 200, output: 100 } },
  ];
  const result = await auditTrace(fakeClient(records) as any, 't1');
  assert.equal(result.status, 'ok');
  // Two model calls for fpA accumulate into one row.
  assert.equal(result.rows[0].fingerprint, 'fpA');
  assert.equal(result.rows[0].inputTokens, 1200);
  assert.equal(result.rows[0].outputTokens, 600);
  assert.equal(result.rows[0].outcome, 'committed');
  assert.equal(result.rows[1].inputTokens, 0);
  assert.deepEqual(result.total, { input: 1200, output: 600 });
});

test('printAudit renders a per-finding table with costs and a total', async () => {
  const records = [
    {
      name: 'settle', type: 'SPAN',
      input: {
        attempts: [
          { fingerprint: 'fpA', check: 'py:bandit', outcome: 'committed', patch: { file: 'a.py', rationale: 'move secret to env' }, provider: false, collateral: [], at: 't' },
        ],
      },
    },
    { name: 'propose', type: 'GENERATION', input: { fingerprint: 'fpA' }, usage: { input: 1_000_000, output: 1_000_000 } },
  ];
  const result = await auditTrace(fakeClient(records) as any, 't1');
  const out = printAudit(result, costUsd);
  assert.ok(out.includes('FINGERPRINT'));
  assert.ok(out.includes('fpA'));
  assert.ok(out.includes('committed'));
  assert.ok(out.includes('TOTAL'));
  // 1M in + 1M out at $5/$25 per 1M = $30 exactly.
  assert.ok(out.includes('30.000000'));
});

test('auditTrace reports no-trace and tolerates a missing settle span', async () => {
  const empty = await auditTrace(fakeClient([]) as any, 'missing');
  assert.equal(empty.status, 'no-trace');
  const noSettle = await auditTrace(fakeClient([{ name: 'observe', type: 'SPAN', input: {} }]) as any, 't');
  assert.equal(noSettle.status, 'ok');
  assert.equal(noSettle.rows.length, 0);
  assert.ok(printAudit(noSettle, costUsd).includes('no kintsugi attempt history'));
});
