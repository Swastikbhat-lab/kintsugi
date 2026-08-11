import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracer, costUsd } from '../src/tracer.js';

test('costUsd derives from real token counts at list prices', () => {
  // 1M input at $5 + 1M output at $25 = $30.
  assert.equal(costUsd(1_000_000, 1_000_000), 30);
  assert.equal(costUsd(0, 0), 0);
  assert.equal(costUsd(500_000, 100_000), 2.5 + 2.5);
});

test('tracer is inert without Langfuse keys — never throws', async () => {
  const tracer = await Tracer.create();
  assert.equal(tracer.active, false);
  // Every method must be a safe no-op.
  tracer.startRun({ sourceRoot: '/x', checks: ['py:test'], budget: 2 });
  tracer.span('observe', { check: 'py:test' });
  tracer.generation('propose', { inputTokens: 10, outputTokens: 5 }, {});
  tracer.flush();
});

class FakeClient {
  spans: any[] = [];
  generations: any[] = [];
  trace(_: any): void {}
  span(input: any): void { this.spans.push(input); }
  generation(input: any): void { this.generations.push(input); }
  flush(): void {}
}

test('verify span mirrors the ledger attempt shape — joinable on fingerprint + outcome', async () => {
  const fake = new FakeClient();
  const tracer = await Tracer.create();
  (tracer as any).client = fake;
  (tracer as any).traceId = 't1';
  tracer.startRun({ sourceRoot: '/repo', checks: ['py:test'], budget: 2 });
  tracer.span('verify', {
    fingerprint: 'abc123',
    check: 'py:bandit',
    code: 'B105',
    patch: { file: '/repo/src/a.py', find: 'PASSWORD = "x"', replace: 'os.environ…', rationale: 'move to env' },
    outcome: 'committed',
    collateral: ['py:lint: F821 Undefined name'],
    provider: false,
    durationMs: 120,
  });
  assert.equal(fake.spans.length, 1);
  const input = fake.spans[0].input as any;
  assert.equal(input.fingerprint, 'abc123');
  assert.equal(input.outcome, 'committed');
  assert.equal(input.patch.find, 'PASSWORD = "x"');
  assert.deepEqual(input.collateral, ['py:lint: F821 Undefined name']);
  assert.equal(input.provider, false);
});

test('generation carries real usage and cost derived from it', async () => {
  const fake = new FakeClient();
  const tracer = await Tracer.create();
  (tracer as any).client = fake;
  (tracer as any).traceId = 't1';
  tracer.startRun({ sourceRoot: '/repo', checks: [], budget: 2 });
  tracer.generation('propose', { inputTokens: 1000, outputTokens: 500 }, { check: 'py:test', candidates: 2 });
  assert.equal(fake.generations.length, 1);
  const g = fake.generations[0] as any;
  assert.deepEqual(g.usage, { input: 1000, output: 500, total: 1500 });
  // 1000/1M * $5 + 500/1M * $25 = 0.005 + 0.0125
  assert.ok(Math.abs(g.metadata.costUsd - 0.0175) < 1e-9);
});

test('settle span carries the attempt history like the ledger', async () => {
  const fake = new FakeClient();
  const tracer = await Tracer.create();
  (tracer as any).client = fake;
  (tracer as any).traceId = 't1';
  tracer.startRun({ sourceRoot: '/repo', checks: [], budget: 2 });
  tracer.span('settle', {
    status: 'converged',
    iterations: 3,
    attempts: [{ fingerprint: 'f1', outcome: 'committed', patch: { file: '/repo/src/a.py', rationale: 'r' }, provider: false, collateral: [], at: 't' }],
  });
  const input = fake.spans[0].input as any;
  assert.equal(input.attempts[0].fingerprint, 'f1');
  assert.equal(input.attempts[0].outcome, 'committed');
});
