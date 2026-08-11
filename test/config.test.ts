import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChecks, loadConfig } from '../src/config.js';
import type { ToolProbe } from '../src/config.js';

/** A fake probe that reports every command as available/unavailable. */
const probe = (available: boolean): ToolProbe => async () => available;

/** A throwaway repo root with the given files (values are file contents). */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kintsugi-config-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const names = (c: { name: string }[]) => c.map((x) => x.name);

test('npm repo: typecheck + test from its own scripts', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }),
  });
  const checks = await defaultChecks(root, probe(true));
  assert.deepEqual(names(checks), ['typecheck', 'test']);
  assert.equal(checks[0].parser, 'tsc');
  assert.equal(checks[1].parser, 'tap');
});

test('python repo: pytest, ruff, bandit, radon and the engine scanners', async () => {
  const root = makeRepo({ 'pyproject.toml': '[project]\nname="demo"\n' });
  const checks = await defaultChecks(root, probe(true));
  assert.deepEqual(names(checks), [
    'py:test', 'py:lint', 'py:bandit', 'py:radon', 'py:perf', 'py:best-practices', 'py:testgen',
  ]);
  assert.equal(checks[0].parser, 'strict');
  assert.equal(checks[0].severity, 'blocker');
  assert.equal(checks[1].severity, 'minor');
  assert.equal(checks[2].severity, 'major');
  // bandit speaks the strict contract; radon always exits 0, so its check
  // parses output on exit 0 and carries a parser of its own.
  assert.ok(checks[2].command.includes('--msg-template'), checks[2].command);
  assert.equal(checks[3].parser, 'radon');
  assert.equal(checks[3].parseOnExit0, true);
  // The stdlib-only scanners need nothing but a Python interpreter.
  assert.equal(checks[4].name, 'py:perf');
  assert.equal(checks[5].name, 'py:best-practices');
  assert.ok(checks[6].command.includes('testgen_detect.py'), checks[6].command);
});

test('python repo without bandit or radon still gets the engine scanners', async () => {
  const root = makeRepo({ 'pyproject.toml': '[project]\nname="demo"\n' });
  const checks = await defaultChecks(root, async (cmd) =>
    cmd.includes('pytest') || cmd.includes('ruff') || cmd.includes('import ast'));
  assert.deepEqual(names(checks), ['py:test', 'py:lint', 'py:perf', 'py:best-practices', 'py:testgen']);
});

test('python repo without pytest gets no python checks', async () => {
  const root = makeRepo({ 'pyproject.toml': '[project]\nname="demo"\n' });
  // pytest unavailable, ruff available — only ruff would be probed, but it is
  // gated on pytest for the venv path; with a bare ruff binary it still adds.
  const checks = await defaultChecks(root, async (cmd) => cmd.includes('ruff') && !cmd.includes('pytest'));
  assert.deepEqual(names(checks), ['py:lint']);
});

test('python repo with no toolchain at all gets nothing', async () => {
  const root = makeRepo({ 'pyproject.toml': '[project]\nname="demo"\n' });
  assert.deepEqual(names(await defaultChecks(root, probe(false))), []);
});

test('python repo prefers its own venv interpreter', async () => {
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const root = makeRepo({ 'pyproject.toml': '[project]\nname="demo"\n', [py]: '' });
  const checks = await defaultChecks(root, probe(true));
  assert.equal(checks[0].name, 'py:test');
  assert.ok(checks[0].command.includes('.venv'), checks[0].command);
});

test('go repo: go:test + go:vet when the go toolchain is present', async () => {
  const root = makeRepo({ 'go.mod': 'module example.com/tax\n\ngo 1.21\n' });
  const checks = await defaultChecks(root, probe(true));
  assert.deepEqual(names(checks), ['go:vet', 'go:test']);
  assert.equal(checks[0].parser, 'strict');
  assert.equal(checks[1].severity, 'blocker');
});

test('go repo without the go toolchain gets nothing', async () => {
  const root = makeRepo({ 'go.mod': 'module example.com/tax\n' });
  assert.deepEqual(names(await defaultChecks(root, probe(false))), []);
});

test('rust repo: rs:lint via clippy and rs:test via cargo when the toolchain is present', async () => {
  const root = makeRepo({ 'Cargo.toml': '[package]\nname = "tax"\nversion = "0.1.0"\n' });
  const checks = await defaultChecks(root, probe(true));
  assert.deepEqual(names(checks), ['rs:lint', 'rs:test']);
  assert.equal(checks[0].parser, 'rust');
  assert.equal(checks[0].severity, 'minor');
  assert.ok(checks[0].command.includes('-D warnings'), checks[0].command);
  assert.equal(checks[1].severity, 'blocker');
  // cargo cold-builds the crate, so the checks carry a longer timeout.
  assert.equal(checks[0].timeoutMs, 300_000);
});

test('rust repo without the cargo toolchain gets nothing', async () => {
  const root = makeRepo({ 'Cargo.toml': '[package]\nname = "tax"\n' });
  assert.deepEqual(names(await defaultChecks(root, probe(false))), []);
});

test('mixed npm + python repo gets the union of toolchains', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'pyproject.toml': '[project]\nname="demo"\n',
  });
  const checks = await defaultChecks(root, probe(true));
  assert.deepEqual(names(checks), [
    'test', 'py:test', 'py:lint', 'py:bandit', 'py:radon', 'py:perf', 'py:best-practices', 'py:testgen',
  ]);
});

test('a repo with no markers at all gets zero checks', async () => {
  const root = makeRepo({ 'README.md': 'nothing to see' });
  assert.deepEqual(names(await defaultChecks(root, probe(true))), []);
});

test('loadConfig prefers an explicit config over auto-detection', async () => {
  const root = makeRepo({
    'pyproject.toml': '[project]\nname="demo"\n',
    'kintsugi.config.json': JSON.stringify({ checks: [{ name: 'custom', command: 'node c.mjs', parser: 'lines' }] }),
  });
  const cfg = await loadConfig(root, undefined, probe(true));
  assert.deepEqual(names(cfg.checks), ['custom']);
});
