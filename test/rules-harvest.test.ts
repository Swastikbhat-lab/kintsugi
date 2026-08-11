import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposePatches } from '../src/propose.js';
import { parseRadon } from '../src/parsers.js';
import { applyEdits } from '../src/patch.js';
import type { Finding } from '../src/types.js';

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kintsugi-harvest-'));
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
    check: 'py:best-practices',
    severity: 'minor',
    summary: 's',
    evidence: {},
    ...over,
  };
}

test('T201: type()== is rewritten to isinstance(), never type(x) == type(y)', async () => {
  const root = makeRepo({ 'a.py': 'def f(x):\n    return type(x) == int\n' });
  const file = join(root, 'a.py');
  const [p] = await proposePatches(finding({
    file, line: 2, code: 'T201',
    summary: 'T201 use isinstance() instead of type()==',
    evidence: { message: 'T201 use isinstance() instead of type()==' },
  }), root);
  assert.ok(p);
  assert.equal(p.find, 'type(x) == int');
  assert.equal(p.replace, 'isinstance(x, int)');

  // Comparing two types is NOT a class check — no rewrite.
  const root2 = makeRepo({ 'b.py': 'def g(x, y):\n    return type(x) == type(y)\n' });
  const none = await proposePatches(finding({
    file: join(root2, 'b.py'), line: 2, code: 'T201',
    summary: 'T201 use isinstance() instead of type()==',
    evidence: { message: 'T201 use isinstance() instead of type()==' },
  }), root2);
  assert.deepEqual(none, []);
});

test('T202: len(x) == 0 becomes not x; len(x) > 0 becomes x', async () => {
  const root = makeRepo({
    'a.py': 'def f(x):\n    if len(x) == 0:\n        return None\n    while len(q) > 0:\n        q.pop()\n',
  });
  const file = join(root, 'a.py');
  const [eq] = await proposePatches(finding({
    file, line: 2, code: 'T202',
    summary: 'T202 use truthiness instead of a len() comparison',
    evidence: { message: 'T202 use truthiness instead of a len() comparison' },
  }), root);
  assert.equal(eq.find, 'len(x) == 0');
  assert.equal(eq.replace, 'not x');

  const [gt] = await proposePatches(finding({
    file, line: 4, code: 'T202',
    summary: 'T202 use truthiness instead of a len() comparison',
    evidence: { message: 'T202 use truthiness instead of a len() comparison' },
  }), root);
  assert.equal(gt.find, 'len(q) > 0');
  assert.equal(gt.replace, 'q');
});

test('T203: key in d.keys() becomes key in d', async () => {
  const root = makeRepo({ 'a.py': 'def f(d):\n    if "k" in d.keys():\n        return True\n' });
  const file = join(root, 'a.py');
  const [p] = await proposePatches(finding({
    file, line: 2, code: 'T203',
    summary: "T203 use 'in d' instead of 'in d.keys()'",
    evidence: { message: "T203 use 'in d' instead of 'in d.keys()'" },
  }), root);
  assert.ok(p);
  assert.equal(p.find, '"k" in d.keys()');
  assert.equal(p.replace, '"k" in d');
});

test('T001: generates a smoke test next to the module, covering every untested function', async () => {
  const root = makeRepo({
    'src/tax.py': 'def calc(amount):\n    return amount * 2\n\n\ndef net(gross):\n    return gross - 1\n',
  });
  const [p] = await proposePatches(finding({
    check: 'py:testgen',
    file: join(root, 'src', 'tax.py'),
    line: 1,
    code: 'T001',
    summary: "T001 function 'calc' has no tests",
    evidence: { message: "T001 function 'calc' has no tests", code: 'T001' },
  }), root);
  assert.ok(p, 'expected a testgen patch');
  assert.equal(p.create, true);
  assert.equal(p.file, join(root, 'src', 'test_tax.py'));
  assert.equal(p.find, '');
  // Sorted member names, importable via pytest's basedir rule, and the
  // patch applies as a new file with a working undo.
  assert.ok(p.replace.includes('from tax import calc, net'), p.replace);
  assert.ok(p.replace.includes('def test_calc_is_importable()'));
  assert.ok(p.replace.includes('def test_net_is_importable()'));

  const restore = applyEdits([p], root);
  assert.ok(existsSync(p.file));
  assert.ok(readFileSync(p.file, 'utf8').includes('assert callable(calc)'));
  restore();
  assert.ok(!existsSync(p.file), 'revert deletes the created file');
});

test('T001: a module inside a package gets the dotted import spec', async () => {
  const root = makeRepo({
    'src/__init__.py': '',
    'src/tax.py': 'def calc(amount):\n    return amount * 2\n',
  });
  const [p] = await proposePatches(finding({
    check: 'py:testgen',
    file: join(root, 'src', 'tax.py'),
    line: 1, code: 'T001',
    summary: "T001 function 'calc' has no tests",
    evidence: { message: "T001 function 'calc' has no tests", code: 'T001' },
  }), root);
  assert.ok(p);
  assert.ok(p.replace.includes('from src.tax import calc'), p.replace);
});

test('T001: no patch once a sibling test file exists', async () => {
  const root = makeRepo({
    'tax.py': 'def calc(amount):\n    return amount * 2\n',
    'test_tax.py': 'from tax import calc\n',
  });
  const patches = await proposePatches(finding({
    check: 'py:testgen',
    file: join(root, 'tax.py'), line: 1, code: 'T001',
    summary: "T001 function 'calc' has no tests",
    evidence: { message: "T001 function 'calc' has no tests", code: 'T001' },
  }), root);
  assert.deepEqual(patches, []);
});

test('parseRadon: C+ functions become findings, A/B ranks are dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'kintsugi-radon-'));
  const out = [
    'src\\tax.py',
    '    F 1:0 apply_tax - C (11)',
    '    F 5:4 helper - A (3)',
    'src\\ok.py',
    '    F 1:0 fine - B (6)',
  ].join('\n');
  const findings = parseRadon(out, root, 'py:radon');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'CC_C');
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].summary, 'cyclomatic complexity C (11): apply_tax');
  assert.match(findings[0].file!, /src[/\\]tax\.py$/);
});
