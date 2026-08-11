import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposePatches } from '../src/propose.js';
import type { Finding } from '../src/types.js';

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kintsugi-rules-'));
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
    check: 'py:lint',
    severity: 'minor',
    summary: 's',
    evidence: {},
    ...over,
  };
}

const apply = (text: string, p: { find: string; replace: string }) => {
  assert.ok(text.includes(p.find), `anchor ${JSON.stringify(p.find)} not in file`);
  return text.replace(p.find, p.replace);
};

// ------------------------------------------------------------- F401

test('F401: removes a whole-line unused import, collapsing a blank line', async () => {
  const root = makeRepo({
    'src/util.py': 'import os\n\n\ndef greet(name: str) -> str:\n    return f"hello {name}"\n',
  });
  const file = join(root, 'src/util.py');
  const [p] = await proposePatches(finding({
    file, line: 1, code: 'F401',
    summary: "F401 [*] `os` imported but unused",
    evidence: { message: "F401 [*] `os` imported but unused", col: 8, code: 'F401' },
  }), root);

  assert.ok(p, 'expected a patch');
  assert.equal(p.find, 'import os\n');
  assert.equal(p.replace, '');
  const text = await import('node:fs').then((f) => f.readFileSync(file, 'utf8'));
  const after = text.replace(p.find, p.replace);
  assert.ok(!after.includes('import os'));
  assert.ok(!after.includes('\n\n\ndef'), 'no double blank left behind');
});

test('F401: accepts the single-quote spelling older ruff versions use', async () => {
  const root = makeRepo({ 'u.py': "import os\n\n\ndef g() -> str:\n    return 'x'\n" });
  const [p] = await proposePatches(finding({
    file: join(root, 'u.py'), line: 1, code: 'F401',
    summary: "F401 [*] 'os' imported but unused",
    evidence: { message: "F401 [*] 'os' imported but unused", code: 'F401' },
  }), root);
  assert.ok(p);
});

test('F401: removes one name from a multi-name import', async () => {
  const root = makeRepo({ 'u.py': 'import os, sys\n\n\ndef g() -> str:\n    return sys.platform\n' });
  const file = join(root, 'u.py');
  const [p] = await proposePatches(finding({
    file, line: 1, code: 'F401',
    summary: "F401 [*] `os` imported but unused",
    evidence: { message: "F401 [*] `os` imported but unused", code: 'F401' },
  }), root);

  assert.ok(p);
  assert.equal(p.replace, 'import sys');
});

test('F401: refuses a non-unique anchor rather than guessing', async () => {
  const root = makeRepo({
    // The comment repeats the import text, so `import os\n` is not unique.
    'u.py': 'import os\n# import os\n\n\ndef g() -> str:\n    return "x"\n',
  });
  const patches = await proposePatches(finding({
    file: join(root, 'u.py'), line: 1, code: 'F401',
    summary: "F401 [*] `os` imported but unused",
    evidence: { message: "F401 [*] `os` imported but unused", code: 'F401' },
  }), root);
  assert.deepEqual(patches, []);
});

// ------------------------------------------------------------- I001

test('I001: sorts an unsorted stdlib import block', async () => {
  const root = makeRepo({
    'src/app.py': 'import sys\nimport os\n\n\ndef run() -> str:\n    return f"{os.name}:{sys.platform}"\n',
  });
  const file = join(root, 'src/app.py');
  const [p] = await proposePatches(finding({
    file, line: 1, code: 'I001',
    summary: 'I001 [*] Import block is un-sorted or un-formatted',
    evidence: { message: 'I001 [*] Import block is un-sorted or un-formatted', code: 'I001' },
  }), root);

  assert.ok(p);
  assert.equal(p.find, 'import sys\nimport os');
  assert.equal(p.replace, 'import os\nimport sys');
});

test('I001: groups stdlib before third-party, third-party before first-party', async () => {
  const root = makeRepo({
    'app.py': 'from src import tax\nimport requests\nimport os\n\n\ndef run() -> str:\n    return str(tax)\n',
  });
  const [p] = await proposePatches(finding({
    file: join(root, 'app.py'), line: 1, code: 'I001',
    summary: 'I001 [*] Import block is un-sorted or un-formatted',
    evidence: { message: 'I001 [*] Import block is un-sorted or un-formatted', code: 'I001' },
  }), root);

  assert.ok(p);
  assert.equal(p.replace, 'import os\nimport requests\nfrom src import tax');
});

test('I001: refuses blocks with comments or parenthesized imports', async () => {
  const root = makeRepo({
    'a.py': 'import sys\nimport os  # keep\n\n\ndef run() -> str:\n    return "x"\n',
    'b.py': 'from x import (a, b)\n\n\ndef run() -> str:\n    return str(a)\n',
  });
  const [a] = await proposePatches(finding({
    file: join(root, 'a.py'), line: 1, code: 'I001',
    summary: 'I001 [*] Import block is un-sorted or un-formatted',
    evidence: { message: 'I001 [*] Import block is un-sorted or un-formatted', code: 'I001' },
  }), root);
  const [b] = await proposePatches(finding({
    file: join(root, 'b.py'), line: 1, code: 'I001',
    summary: 'I001 [*] Import block is un-sorted or un-formatted',
    evidence: { message: 'I001 [*] Import block is un-sorted or un-formatted', code: 'I001' },
  }), root);
  assert.ok(!a);
  assert.ok(!b);
});

// ------------------------------------------------------------- stale constant

test('py:test: a failing assertion reveals the right constant', async () => {
  const root = makeRepo({
    'src/tax.py': 'def apply_tax(amount: float) -> float:\n    return amount * 0.08\n',
    'test_tax.py': 'from src.tax import apply_tax\n\n\ndef test_apply_tax():\n    assert apply_tax(100) == 10\n',
  });
  const [p] = await proposePatches(finding({
    check: 'py:test', severity: 'blocker',
    file: join(root, 'test_tax.py'), line: 5,
    summary: 'assert 8.0 == 10',
    evidence: { message: 'assert 8.0 == 10' },
  }), root);

  assert.ok(p, 'expected the constant to be repaired');
  assert.equal(p.find, 'amount * 0.08');
  assert.equal(p.replace, 'amount * 0.1');
  assert.equal(p.file, join(root, 'src/tax.py'));
});

test('py:test: supports the mirrored assertion `assert want == f(n)`', async () => {
  const root = makeRepo({
    'tax.py': 'def apply_tax(amount: float) -> float:\n    return amount * 0.08\n',
    'test_tax.py': 'from tax import apply_tax\n\n\ndef test():\n    assert 10 == apply_tax(100)\n',
  });
  const [p] = await proposePatches(finding({
    check: 'py:test', severity: 'blocker',
    file: join(root, 'test_tax.py'), line: 5,
    summary: 'assert 8.0 == 10',
    evidence: { message: 'assert 8.0 == 10' },
  }), root);
  assert.ok(p);
  assert.equal(p.replace, 'amount * 0.1');
});

test('py:test: refuses a non-clean ratio like 10/3', async () => {
  const root = makeRepo({
    'tax.py': 'def split(amount: float) -> float:\n    return amount * 3\n',
    'test_tax.py': 'from tax import split\n\n\ndef test():\n    assert split(3) == 10\n',
  });
  const patches = await proposePatches(finding({
    check: 'py:test', severity: 'blocker',
    file: join(root, 'test_tax.py'), line: 5,
    summary: 'assert 9 == 10',
    evidence: { message: 'assert 9 == 10' },
  }), root);
  assert.deepEqual(patches, []);
});

// ------------------------------------------------------------- go

test('go:test: removes an unused import spec from an import block', async () => {
  const root = makeRepo({
    'main.go': 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\t_ = os.Args\n}\n',
  });
  const file = join(root, 'main.go');
  const [p] = await proposePatches(finding({
    check: 'go:test', severity: 'blocker',
    file, line: 4,
    summary: 'imported and not used: "fmt"',
    evidence: { message: 'imported and not used: "fmt"' },
  }), root);

  assert.ok(p);
  assert.equal(p.find, '\n\t"fmt"\n');
  assert.equal(p.replace, '\n');
});

test('go:test: removes a whole-line unused import', async () => {
  const root = makeRepo({
    'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("x")\n}\n',
  });
  const file = join(root, 'main.go');
  const [p] = await proposePatches(finding({
    check: 'go:test', severity: 'blocker',
    file, line: 3,
    summary: 'imported and not used: "fmt"',
    evidence: { message: 'imported and not used: "fmt"' },
  }), root);
  assert.ok(p);
  // Line 3 is not the first line, so the anchor includes the preceding newline.
  assert.equal(p.find, '\nimport "fmt"\n');
  assert.equal(p.replace, '\n');
});

test('go:test: Equal(t, want, f(n)) reveals the constant', async () => {
  const root = makeRepo({
    'tax.go': 'package tax\n\nfunc applyTax(amount float64) float64 {\n\treturn amount * 0.08\n}\n',
    'tax_test.go': 'package tax\n\nimport "testing"\n\nfunc TestApplyTax(t *testing.T) {\n\tassert.Equal(t, 10, applyTax(100))\n}\n',
  });
  const [p] = await proposePatches(finding({
    check: 'go:test', severity: 'blocker',
    file: join(root, 'tax_test.go'), line: 6,
    summary: 'expected 10, got 5',
    evidence: { message: 'expected 10, got 5' },
  }), root);
  assert.ok(p, 'expected the constant to be repaired');
  assert.equal(p.find, 'amount * 0.08');
  assert.equal(p.replace, 'amount * 0.1');
  assert.equal(p.file, join(root, 'tax.go'));
});

test('go:test: the plain `if got := f(n); got != want` shape works too', async () => {
  const root = makeRepo({
    'tax.go': 'package tax\n\nfunc applyTax(amount float64) float64 {\n\treturn amount * 0.08\n}\n',
    'tax_test.go': 'package tax\n\nimport "testing"\n\nfunc TestApplyTax(t *testing.T) {\n\tif got := applyTax(100); got != 10 {\n\t\tt.Fatalf("expected %v, got %v", 10, got)\n\t}\n}\n',
  });
  const [p] = await proposePatches(finding({
    check: 'go:test', severity: 'blocker',
    file: join(root, 'tax_test.go'), line: 6,
    summary: 'expected 10, got 5',
    evidence: { message: 'expected 10, got 5' },
  }), root);
  assert.ok(p);
  assert.equal(p.replace, 'amount * 0.1');
});

test('a rule patch applies cleanly through applyEdits', async () => {
  const root = makeRepo({
    'src/tax.py': 'def apply_tax(amount: float) -> float:\n    return amount * 0.08\n',
    'test_tax.py': 'from src.tax import apply_tax\n\n\ndef test_apply_tax():\n    assert apply_tax(100) == 10\n',
  });
  const [p] = await proposePatches(finding({
    check: 'py:test', severity: 'blocker',
    file: join(root, 'test_tax.py'), line: 5,
    summary: 'assert 8.0 == 10',
    evidence: { message: 'assert 8.0 == 10' },
  }), root);
  assert.ok(p);
  const { applyEdits } = await import('../src/patch.js');
  const restore = applyEdits([p], root);
  const after = await import('node:fs').then((f) => f.readFileSync(join(root, 'src/tax.py'), 'utf8'));
  assert.ok(after.includes('amount * 0.1'));
  assert.ok(!after.includes('amount * 0.08'));
  restore();
  const back = await import('node:fs').then((f) => f.readFileSync(join(root, 'src/tax.py'), 'utf8'));
  assert.ok(back.includes('amount * 0.08'));
});
