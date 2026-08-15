import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Loop } from '../src/loop.js';
import { copyFixture, tempStatePath } from './helpers.js';
import type { Provider } from '../src/provider.js';
import type { Patch, RunConfig, Finding } from '../src/types.js';

/** A provider that localizes before proposing, recording what it saw. */
class LocalizingProvider implements Provider {
  readonly name = 'localizing-test';
  localized: Finding | null = null;
  proposedWithLocalization = false;
  async preflight() {
    return { ok: true, detail: 'reachable' };
  }
  async localize(finding: Finding) {
    this.localized = finding;
    return {
      rootCause: 'the tax rate is wrong',
      symbols: ['applyTax'],
      strategy: 'return the correct rate',
      confidence: 'high' as const,
    };
  }
  async propose(_f: Finding, _root: string, context?: import('../src/provider.js').ProposerContext & { localization?: unknown }) {
    if (context?.localization) this.proposedWithLocalization = true;
    const patch: Patch = {
      id: 't', file: '', find: '', replace: '', rationale: '', scope: 'local',
    };
    return [patch];
  }
  async critique() {
    return { verdict: 'keep' as const, reason: 'ok' };
  }
}

test('the loop runs the researcher (localize) before proposing and hands it to the proposer', async () => {
  const source = copyFixture();
  const cfg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixture/kintsugi.config.json'), 'utf8'));
  const provider = new LocalizingProvider();
  const config: RunConfig = {
    sourceRoot: source,
    checks: cfg.checks,
    budget: cfg.budget,
    maxIterations: cfg.maxIterations,
    dryRun: false,
    allowShared: cfg.allowShared,
    statePath: tempStatePath(),
    provider,
  };

  const events: string[] = [];
  const state = await new Loop(config, (e) => events.push(e.message)).run();

  // The localize step ran against a real finding and the events fired.
  assert.ok(provider.localized, 'researcher was consulted');
  assert.ok(events.some((m) => m.startsWith('Researcher:')), `expected researcher event, got: ${events.filter((e) => e.includes('Researcher')).join(' | ')}`);
  assert.ok(events.some((m) => m.startsWith('Planner:')), 'expected planner event');
  // The localization reached the proposer.
  assert.ok(provider.proposedWithLocalization, 'proposer received the localization');
  // The loop ran end to end — at least one iteration completed.
  assert.ok(state.iteration >= 1);
  assert.ok(['converged', 'exhausted', 'failed'].includes(state.status));
});

test('the loop repairs five defect classes and quarantines the sixth', async () => {
  const source = copyFixture();
  // Same config the fixture ships with — one source of truth for the demo
  // and the end-to-end test.
  const cfg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixture/kintsugi.config.json'), 'utf8'));
  const config: RunConfig = {
    sourceRoot: source,
    checks: cfg.checks,
    budget: cfg.budget,
    maxIterations: cfg.maxIterations,
    dryRun: false,
    allowShared: cfg.allowShared,
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
