import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Loop } from '../src/loop.js';
import { copyFixture, tempStatePath } from './helpers.js';
import type { RunConfig } from '../src/types.js';

test('the loop repairs five defect classes and quarantines the sixth', async () => {
  const source = copyFixture();
  const config: RunConfig = {
    sourceRoot: source,
    checks: [
      { name: 'typecheck', command: 'npm run typecheck', parser: 'tsc', severity: 'major' },
      { name: 'lint', command: 'npm run lint', parser: 'tsc', severity: 'minor' },
      { name: 'test', command: 'npm test', parser: 'tap', severity: 'blocker' },
      { name: 'version', command: 'npm run check:version', parser: 'lines', severity: 'minor' },
    ],
    budget: 2,
    maxIterations: 12,
    dryRun: false,
    allowShared: false,
    llmMock: resolve(import.meta.dirname, '../fixture/proposals/tax-rate.json'),
    statePath: tempStatePath(),
  };

  const events: string[] = [];
  const state = await new Loop(config, (e) => events.push(e.message)).run();

  assert.equal(state.status, 'converged');

  const committed = state.attempts.filter((a) => a.outcome === 'committed');
  assert.equal(committed.length, 5, `expected 5 committed, got: ${JSON.stringify(committed.map((a) => a.patch.rationale))}`);

  // The tax-rate finding was tried with a bad guess first, disproved by the
  // checks, then repaired with the good one — the loop learns from its miss.
  const taxAttempts = state.attempts.filter((a) => a.patch.find === 'return amount * 0.08;');
  assert.equal(taxAttempts.length, 2, 'expected bad then good tax-rate attempts');
  assert.equal(taxAttempts[0].outcome, 'ineffective');
  assert.equal(taxAttempts[1].outcome, 'committed');

  // The one defect with no mechanical answer is quarantined with evidence.
  const quarantined = state.attempts.filter((a) => a.patch.id === 'none');
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0].patch.rationale, /loadConfig/);

  // Nothing actionable remains — the rest is a human decision.
  const loop = new Loop(config, () => {});
  assert.equal(loop.actionableRemaining().length, 0);

  // The control test never broke.
  assert.ok(events.some((m) => m.includes('committed — finding cleared with no collateral')));
});
