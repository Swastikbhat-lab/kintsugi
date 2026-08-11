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
