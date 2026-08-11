import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Loop } from '../src/loop.js';
import { tempStatePath } from './helpers.js';
import type { RunConfig } from '../src/types.js';

/** A working cargo: CARGO env, then `cargo`. */
function cargo(): string | null {
  const cands = [process.env.CARGO, 'cargo'].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 15_000, encoding: 'utf8' });
      if (r.status === 0) return c;
    } catch { /* keep probing */ }
  }
  return null;
}

const CARGO = cargo();

test('the loop repairs a Rust fixture: stale constant and unused use import', { skip: !CARGO ? 'cargo not installed — set CARGO to run' : false }, async () => {
  const source = mkdtempSync(join(tmpdir(), 'kintsugi-rust-loop-'));
  mkdirSync(join(source, 'src'), { recursive: true });
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "tax-demo"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'use std::fmt;\n\npub fn apply_tax(amount: f64) -> f64 {\n    amount * 0.08\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn test_applies_tax() {\n        assert_eq!(apply_tax(100.0), 10.0);\n    }\n}\n',
  };
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(source, path), content);
  }

  const q = (c: string) => `"${c}"`;
  const config: RunConfig = {
    sourceRoot: source,
    checks: [
      { name: 'rs:lint', command: `${q(CARGO!)} clippy -- -D warnings`, parser: 'rust', severity: 'minor', timeoutMs: 300_000 },
      { name: 'rs:test', command: `${q(CARGO!)} test --quiet`, parser: 'rust', severity: 'blocker', timeoutMs: 300_000 },
    ],
    budget: 2,
    maxIterations: 12,
    dryRun: false,
    allowShared: false,
    statePath: tempStatePath(),
  };

  const events: string[] = [];
  const state = await new Loop(config, (e) => events.push(e.message)).run();

  assert.equal(state.status, 'converged');

  const committed = state.attempts.filter((a) => a.outcome === 'committed');
  assert.equal(committed.length, 2, `expected 2 committed, got: ${JSON.stringify(committed.map((a) => a.patch.rationale))}`);

  const rationales = committed.map((a) => a.patch.rationale).join('\n');
  assert.match(rationales, /setting it to 0\.1/, 'stale constant repaired');
  assert.match(rationales, /removing the use/, 'unused import removed');

  // Nothing actionable remains — the fixture is genuinely repaired.
  const loop = new Loop(config, () => {});
  assert.equal(loop.actionableRemaining().length, 0);
});
