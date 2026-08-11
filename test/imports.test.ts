import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildImportGraph, scopeOf } from '../src/imports.js';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kintsugi-imports-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    const dir = dirname(p);
    if (dir !== root) mkdirSync(dir, { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

test('a file imported by two modules is shared', () => {
  const root = repo({
    'shared.ts': 'export const x = 1;',
    'a.ts': "import { x } from './shared.js'; export const a = x;",
    'b.ts': "import { x } from './shared.js'; export const b = x;",
    'solo.ts': 'export const y = 2;',
  });
  assert.ok(root);
  const g = buildImportGraph(root);
  const shared = [...g.files].find((f) => f.endsWith('shared.ts'))!;
  const solo = [...g.files].find((f) => f.endsWith('solo.ts'))!;
  assert.equal(scopeOf(g, shared).scope, 'shared');
  assert.equal(scopeOf(g, shared).importers, 2);
  assert.equal(scopeOf(g, solo).scope, 'local');
});

test('node_modules and dist are excluded from the graph', () => {
  const root = repo({
    'src/a.ts': 'export const a = 1;',
    'node_modules/x/index.ts': 'export const junk = 1;',
    'dist/bundle.ts': 'export const junk2 = 1;',
  });
  const g = buildImportGraph(root);
  assert.ok(![...g.files].some((f) => f.includes('node_modules') || f.includes('dist')));
});
