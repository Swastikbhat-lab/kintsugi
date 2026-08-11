import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/audit_log.js';
import { costUsd } from '../src/tracer.js';
import { MockProvider } from '../src/provider.js';

test('AuditLog writes one NDJSON line per attempt plus a reconciling summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kintsugi-audit-'));
  try {
    const path = join(dir, 'audit.jsonl');
    const log = new AuditLog(path, costUsd);
    log.attempt({
      fingerprint: 'fp1', outcome: 'committed', check: 'py:test',
      rationale: 'rate 0.1', provider: true, collateral: [],
      usage: { input: 1500, output: 700 }, runId: 'run1',
    });
    log.attempt({ fingerprint: 'fp2', outcome: 'quarantined', check: 'py:bandit', usage: { input: 0, output: 0 }, runId: 'run1' });
    log.summary({ runId: 'run1', status: 'converged', iterations: 2, committed: 1, reverted: 0, quarantined: 1, usage: { input: 1500, output: 700 } });
    log.close();

    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].event, 'attempt');
    assert.equal(lines[0].fingerprint, 'fp1');
    assert.equal(lines[0].outcome, 'committed');
    assert.deepEqual(lines[0].usage, { input: 1500, output: 700 });
    // 1500/1M * $5 + 700/1M * $25 = 0.0075 + 0.0175 = 0.025
    assert.ok(Math.abs(lines[0].costUsd - 0.025) < 1e-9);
    assert.equal(lines[1].outcome, 'quarantined');
    assert.equal(lines[2].event, 'summary');
    assert.equal(lines[2].committed, 1);
    assert.ok(Math.abs(lines[2].costUsd - 0.025) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AuditLog without a path is a silent no-op; a bad path degrades without throwing', () => {
  const noop = new AuditLog(null, costUsd);
  assert.equal(noop.active, false);
  noop.attempt({ fingerprint: 'f', outcome: 'committed', runId: 'r' });
  noop.summary({ runId: 'r' });
  noop.close(); // must not throw

  // Unwritable path (a directory) must not throw from the constructor.
  const dir = mkdtempSync(join(tmpdir(), 'kintsugi-audit-bad-'));
  try {
    const bad = new AuditLog(dir, costUsd); // openSync on a directory fails
    bad.attempt({ fingerprint: 'f', outcome: 'committed' });
    bad.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MockProvider reports replayed usage so keyless runs exercise the audit cost path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kintsugi-audit-mock-'));
  try {
    const path = join(dir, 'props.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, JSON.stringify([{
      match: { check: 'py:test', contains: 'assert 100 == 10' },
      candidates: [{ file: 'tax.py', find: 'return amount', replace: 'return amount * 0.1', rationale: 'rate' }],
      usage: { inputTokens: 1500, outputTokens: 700 },
    }]));
    const { mkdirSync, writeFileSync: wfs } = await import('node:fs');
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    wfs(join(repo, 'tax.py'), 'return amount');
    const provider = new MockProvider(path);
    const patches = await provider.propose({ check: 'py:test', summary: 'assert 100 == 10', fingerprint: 'f', severity: 'minor', evidence: {} } as any, repo);
    assert.equal(patches.length, 1);
    assert.deepEqual(provider.lastUsage, { inputTokens: 1500, outputTokens: 700 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
