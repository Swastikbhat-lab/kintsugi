import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposePatches } from '../src/propose.js';
import type { Finding } from '../src/types.js';

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kintsugi-rust-rules-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function finding(over: Partial<Finding>): Finding {
  return {
    fingerprint: 'f',
    check: 'rs:lint',
    severity: 'minor',
    summary: 's',
    evidence: {},
    ...over,
  };
}

// ------------------------------------------------------------- unused use import

test('rs:lint: removes a whole-line unused use import, collapsing a blank line', async () => {
  const root = makeRepo({
    'src/lib.rs': 'use std::fmt;\n\npub fn greet() -> String {\n    "hi".to_string()\n}\n',
  });
  const file = join(root, 'src/lib.rs');
  const [p] = await proposePatches(finding({
    file, line: 1, code: 'unused_imports',
    summary: 'unused import: `std::fmt`',
    evidence: { message: 'unused import: `std::fmt`', code: 'unused_imports' },
  }), root);

  assert.ok(p, 'expected a patch');
  assert.equal(p.find, 'use std::fmt;\n');
  assert.equal(p.replace, '');
  const text = await import('node:fs').then((f) => f.readFileSync(file, 'utf8'));
  const after = text.replace(p.find, p.replace);
  assert.ok(!after.includes('use std::fmt'));
  assert.ok(!after.includes('\n\n\npub'), 'no double blank left behind');
});

test('rs:lint: removes an aliased import but refuses group imports', async () => {
  const root = makeRepo({
    'a.rs': 'use std::fmt as f;\n\npub fn g() -> u32 { 1 }\n',
    'b.rs': 'use std::collections::{HashMap, HashSet};\n\npub fn g() -> u32 { HashSet::new().len() as u32 }\n',
  });
  const [a] = await proposePatches(finding({
    file: join(root, 'a.rs'), line: 1, code: 'unused_imports',
    summary: 'unused import: `std::fmt`',
    evidence: { message: 'unused import: `std::fmt`', code: 'unused_imports' },
  }), root);
  const [b] = await proposePatches(finding({
    file: join(root, 'b.rs'), line: 1, code: 'unused_imports',
    summary: 'unused import: `HashMap`',
    evidence: { message: 'unused import: `HashMap`', code: 'unused_imports' },
  }), root);
  assert.ok(a, 'aliased whole-line import is removable');
  assert.ok(!b, 'group import is refused');
});

// ------------------------------------------------------------- stale constant

test('rs:test: a failing assert_eq! reveals the right constant', async () => {
  const root = makeRepo({
    'src/lib.rs': 'pub fn apply_tax(amount: f64) -> f64 {\n    amount * 0.08\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn test_applies_tax() {\n        assert_eq!(apply_tax(100.0), 10.0);\n    }\n}\n',
  });
  const [p] = await proposePatches(finding({
    check: 'rs:test', severity: 'blocker',
    file: join(root, 'src/lib.rs'), line: 11,
    summary: 'assertion `left == right` failed',
    evidence: { message: 'assertion `left == right` failed' },
  }), root);

  assert.ok(p, 'expected the constant to be repaired');
  assert.equal(p.find, 'amount * 0.08');
  assert.equal(p.replace, 'amount * 0.1');
  assert.equal(p.file, join(root, 'src/lib.rs'));
});

test('rs:test: supports the mirrored assert_eq!(want, f(n))', async () => {
  const root = makeRepo({
    'src/lib.rs': 'pub fn apply_tax(amount: f64) -> f64 {\n    amount * 0.08\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn t() {\n        assert_eq!(10.0, apply_tax(100.0));\n    }\n}\n',
  });
  const [p] = await proposePatches(finding({
    check: 'rs:test', severity: 'blocker',
    file: join(root, 'src/lib.rs'), line: 11,
    summary: 'assertion `left == right` failed',
    evidence: { message: 'assertion `left == right` failed' },
  }), root);
  assert.ok(p);
  assert.equal(p.replace, 'amount * 0.1');
});

test('rs:test: accepts f64-suffixed literals and refuses a non-clean ratio', async () => {
  const root = makeRepo({
    'a.rs': 'pub fn apply_tax(amount: f64) -> f64 {\n    amount * 0.08_f64\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {\n        assert_eq!(apply_tax(100.0), 10.0);\n    }\n}\n',
    'b.rs': 'pub fn split(amount: f64) -> f64 {\n    amount * 3.0\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {\n        assert_eq!(split(3.0), 10.0);\n    }\n}\n',
  });
  const [a] = await proposePatches(finding({
    check: 'rs:test', severity: 'blocker',
    file: join(root, 'a.rs'), line: 9,
    summary: 'assertion `left == right` failed',
    evidence: { message: 'assertion `left == right` failed' },
  }), root);
  const [b] = await proposePatches(finding({
    check: 'rs:test', severity: 'blocker',
    file: join(root, 'b.rs'), line: 9,
    summary: 'assertion `left == right` failed',
    evidence: { message: 'assertion `left == right` failed' },
  }), root);
  assert.ok(a);
  assert.equal(a.replace, 'amount * 0.1');
  assert.ok(!b, '10/3 is float noise, not a constant');
});
