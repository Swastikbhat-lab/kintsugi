import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Loop } from '../src/loop.js';
import { tempStatePath } from './helpers.js';
import type { RunConfig } from '../src/types.js';

/** The interpreter whose `-m pytest` works: PYTEST env, python3, then python. */
function findPytest(): string | null {
  const cands = [process.env.PYTEST, 'python3', 'python'].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['-m', 'pytest', '--version'], { timeout: 15_000, encoding: 'utf8' });
      if (r.status === 0) return c;
    } catch { /* keep probing */ }
  }
  return null;
}

/** A working ruff invocation: RUFF env, `ruff`, then `<pytest> -m ruff`. */
function findRuff(pytest: string): string | null {
  const cands = [process.env.RUFF, 'ruff'].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 15_000, encoding: 'utf8' });
      if (r.status === 0) return c;
    } catch { /* keep probing */ }
  }
  try {
    const r = spawnSync(pytest, ['-m', 'ruff', '--version'], { timeout: 15_000, encoding: 'utf8' });
    if (r.status === 0) return `${pytest} -m ruff`;
  } catch { /* not available */ }
  return null;
}

const PYTEST = findPytest();
const RUFF = PYTEST ? findRuff(PYTEST) : null;

test('the loop repairs a Python fixture: stale constant, unsorted imports, unused import', { skip: !PYTEST || !RUFF ? 'pytest and/or ruff not installed — set PYTEST/RUFF to run' : false }, async () => {
  const source = mkdtempSync(join(tmpdir(), 'kintsugi-py-loop-'));
  mkdirSync(join(source, 'src'), { recursive: true });
  const files: Record<string, string> = {
    // isort's I001 is not in ruff's default selection before 0.16, so the
    // fixture selects it explicitly — the test must pass on any ruff.
    'pyproject.toml': '[project]\nname = "tax-demo"\nversion = "0.1.0"\n\n[tool.ruff.lint]\nselect = ["E4", "E7", "E9", "F", "I"]\n',
    'src/tax.py': 'def apply_tax(amount: float) -> float:\n    return amount * 0.08\n',
    'src/util.py': 'import os\n\n\ndef greet(name: str) -> str:\n    return f"hello {name}"\n',
    'src/app.py': 'import sys\nimport os\n\n\ndef run() -> str:\n    return f"{os.name}:{sys.platform}"\n',
    'test_tax.py': 'from src.tax import apply_tax\n\n\ndef test_apply_tax():\n    assert apply_tax(100) == 10\n',
  };
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(source, path), content);
  }

  const q = (cmd: string) => `"${cmd}"`;
  const config: RunConfig = {
    sourceRoot: source,
    checks: [
      { name: 'py:test', command: `${q(PYTEST!)} -m pytest -q --tb=line`, parser: 'strict', severity: 'blocker' },
      { name: 'py:lint', command: `${RUFF!} check . --output-format=concise`, parser: 'strict', severity: 'minor' },
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
  assert.equal(committed.length, 3, `expected 3 committed, got: ${JSON.stringify(committed.map((a) => a.patch.rationale))}`);

  const rationales = committed.map((a) => a.patch.rationale).join('\n');
  assert.match(rationales, /setting it to 0\.1/, 'stale constant repaired');
  assert.match(rationales, /sorting it/, 'import block sorted');
  assert.match(rationales, /removing the import/, 'unused import removed');

  // Every fix was verified by re-running the real checks.
  assert.ok(events.some((m) => m.includes('committed — finding cleared with no collateral')));

  // Nothing actionable remains — the fixture is genuinely repaired.
  const loop = new Loop(config, () => {});
  assert.equal(loop.actionableRemaining().length, 0);
});
