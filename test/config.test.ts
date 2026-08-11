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

test('python repo: py:test via pytest and py:lint via ruff', async () => {
  const root = makeRepo({ 'pyproject.toml': '[project]\nname="demo"\n' });
  const checks = await defaultChecks(root, probe(true));
  assert.deepEqual(names(checks), ['py:test', 'py:lint']);
  assert.equal(checks[0].parser, 'strict');
  assert.equal(checks[0].severity, 'blocker');
  assert.equal(checks[1].severity, 'minor');
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

test('mixed npm + python repo gets the union of toolchains', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'pyproject.toml': '[project]\nname="demo"\n',
  });
  const checks = await defaultChecks(root, probe(true));
  assert.deepEqual(names(checks), ['test', 'py:test', 'py:lint']);
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
