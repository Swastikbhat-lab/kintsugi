import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Loop } from '../src/loop.js';
import { tempStatePath } from './helpers.js';
import type { RunConfig } from '../src/types.js';

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
// The engine's own scanner scripts are invoked by path from the config.
// They must exist for the py:perf / py:best-practices / py:testgen checks.
const ENGINE_PY = join(dirname(fileURLToPath(import.meta.url)), '..', 'py', 'kintsugi');

test('the loop repairs best-practice findings and generates tests for untested modules',
  { skip: !PYTEST || !RUFF ? 'pytest and/or ruff not installed — set PYTEST/RUFF to run' : false },
  async () => {
    const source = mkdtempSync(join(tmpdir(), 'kintsugi-harvest-loop-'));
    mkdirSync(join(source, 'src'), { recursive: true });
    writeFileSync(join(source, 'pyproject.toml'),
      '[project]\nname = "harvest-demo"\nversion = "0.1.0"\n\n[tool.ruff.lint]\nselect = ["E4", "E7", "E9", "F", "I"]\n');
    writeFileSync(join(source, 'src', 'app.py'),
      'def look(x):\n    if type(x) == int:\n        return x\n    if len(x) == 0:\n        return None\n    return x\n');
    writeFileSync(join(source, 'src', 'tax.py'), 'def calc(amount):\n    return amount * 2\n');

    const q = (cmd: string) => `"${cmd}"`;
    const py = PYTEST!;
    const config: RunConfig = {
      sourceRoot: source,
      checks: [
        { name: 'py:test', command: `${q(py)} -m pytest -q --tb=line`, parser: 'strict', severity: 'blocker' },
        { name: 'py:lint', command: `${RUFF!} check . --output-format=concise`, parser: 'strict', severity: 'minor' },
        { name: 'py:perf', command: `${q(py)} "${join(ENGINE_PY, 'lint_perf.py')}" .`, parser: 'strict', severity: 'minor' },
        { name: 'py:best-practices', command: `${q(py)} "${join(ENGINE_PY, 'lint_best.py')}" .`, parser: 'strict', severity: 'minor' },
        { name: 'py:testgen', command: `${q(py)} "${join(ENGINE_PY, 'testgen_detect.py')}" .`, parser: 'strict', severity: 'minor' },
      ],
      budget: 2,
      maxIterations: 15,
      dryRun: false,
      allowShared: false,
      statePath: tempStatePath(),
    };

    const events: string[] = [];
    const state = await new Loop(config, (e) => events.push(e.message)).run();

    assert.equal(state.status, 'converged');

    const committed = state.attempts.filter((a) => a.outcome === 'committed');
    const rationales = committed.map((a) => a.patch.rationale).join('\n');
    assert.match(rationales, /using isinstance\(\)/, 'T201 fixed');
    assert.match(rationales, /using truthiness instead/, 'T202 fixed');
    assert.match(rationales, /generating a smoke test/, 'testgen fixed');

    // The generated test files exist and are lint- and pytest-clean.
    assert.ok(existsSync(join(source, 'src', 'test_app.py')), 'test_app.py generated');
    assert.ok(existsSync(join(source, 'src', 'test_tax.py')), 'test_tax.py generated');
    assert.match(readFileSync(join(source, 'src', 'test_app.py'), 'utf8'), /from app import look/);

    // The untested-function findings are gone, so nothing actionable remains.
    const loop = new Loop(config, () => {});
    assert.equal(loop.actionableRemaining().length, 0);

    rmSync(source, { recursive: true, force: true });
  });
