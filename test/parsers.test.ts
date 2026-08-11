import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseTsc, parseTap, parseLines, parseSpec, parseStrict, parseRust } from '../src/parsers.js';

const CWD = '/repo';

/** Drive-letter and backslash agnostic, so the same test runs on any OS. */
const norm = (p?: string) => (p ?? '').replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');

test('tsc parser extracts file, line, code and message', () => {
  const out = [
    'src/app.ts(2,10): error TS2307: Cannot find module \'./shipping-costs.js\' or its corresponding type declarations.',
    'src/pricing.ts(1,7): error TS6133: \'TAX_RATE\' is declared but its value is never read.',
  ].join('\n');
  const f = parseTsc(out, CWD, 'typecheck');

  assert.equal(f.length, 2);
  assert.equal(f[0].check, 'typecheck');
  assert.equal(norm(f[0].file), '/repo/src/app.ts');
  assert.equal(f[0].line, 2);
  assert.equal(f[0].code, 'TS2307');
  assert.equal(f[0].evidence.module, './shipping-costs.js');
  assert.equal(f[1].code, 'TS6133');
  assert.equal(f[1].evidence.symbol, 'TAX_RATE');
});

test('tsc parser extracts the member and module from TS2305', () => {
  const out = 'src/cart.ts(1,10): error TS2305: Module \'"./pricing.js"\' has no exported member \'lineTotal\'.';
  const [f] = parseTsc(out, CWD, 'typecheck');
  assert.equal(f.code, 'TS2305');
  assert.equal(f.evidence.member, 'lineTotal');
  assert.equal(f.evidence.module, './pricing.js');
});

test('tsc parser extracts the member from TS2459 (declared but not exported)', () => {
  const out = 'src/cart.ts(1,10): error TS2459: Module \'"./pricing.js"\' declares \'lineTotal\' locally, but it is not exported.';
  const [f] = parseTsc(out, CWD, 'typecheck');
  assert.equal(f.code, 'TS2459');
  assert.equal(f.evidence.member, 'lineTotal');
  assert.equal(f.evidence.module, './pricing.js');
});

test('tsc parser drops findings outside the source root', () => {
  const out = 'C:/Users/me/AppData/Roaming/npm/node_modules/x.ts(1,1): error TS1000: noise.';
  assert.equal(parseTsc(out, CWD, 'typecheck').length, 0);
});

test('tap parser handles per-file TAP blocks', () => {
  const out = [
    'TAP version 13',
    '# Subtest: test/pricing.test.ts',
    '    ok 1 - lineTotal multiplies quantity by price',
    '    not ok 2 - applyTax applies the 10% tax rate',
    '      ---',
    '      error: AssertionError [ERR_ASSERTION]: expected 8 to equal 10',
    '          at file:///repo/test/pricing.test.ts:13:10',
    '      ...',
    '    1..2',
    'ok 1 - test/pricing.test.ts',
    '1..1',
  ].join('\n');
  const f = parseTap(out, CWD, 'test');

  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'blocker');
  assert.equal(f[0].summary, 'applyTax applies the 10% tax rate');
  assert.equal(norm(f[0].file), '/repo/test/pricing.test.ts');
  assert.equal(f[0].line, 13);
});

test('tap parser reads the location field when there is no stack line', () => {
  // A real `location:` field carries an absolute path inside the source root
  // — as the OS spells it. Deriving it from the resolved CWD keeps this test
  // green on Windows (C:/repo/…) and POSIX (/repo/…) alike; a hardcoded
  // `C:/repo/…` silently failed on Linux CI.
  const root = resolve(CWD).replace(/\\/g, '/');
  const out = [
    'not ok 1 - applyTax applies the 10% tax rate',
    '  ---',
    `  location: '${root}/test/pricing.test.ts:6:1'`,
    '  failureType: testCodeFailure',
    '  ...',
  ].join('\n');
  const [f] = parseTap(out, CWD, 'test');
  assert.equal(f.summary, 'applyTax applies the 10% tax rate');
  assert.equal(norm(f.file), '/repo/test/pricing.test.ts');
  assert.equal(f.line, 6);
});

test('spec parser reads a failing test and its stack location', () => {
  const out = [
    '✔ a passing test (1.2ms)',
    '✖ the loop repairs five defect classes and quarantines the sixth (12774.48ms)',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at test\\loop.test.ts:9:1',
    '✖ the loop repairs five defect classes and quarantines the sixth (12774.48ms)',
    '  AssertionError [ERR_ASSERTION]: expected 5 committed, got: []',
    '  ',
    '      at TestContext.<anonymous> (file:///repo/test/loop.test.ts:31:10)',
  ].join('\n');
  const f = parseSpec(out, CWD, 'test');

  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'blocker');
  assert.equal(f[0].summary, 'the loop repairs five defect classes and quarantines the sixth');
  assert.equal(norm(f[0].file), '/repo/test/loop.test.ts');
  assert.equal(f[0].line, 31);
});

test('spec parser skips the summary heading and dedupes repeated titles', () => {
  const out = [
    '✖ a fails on windows paths (5ms)',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at test\\parsers.test.ts:71:1',
    '✖ a fails on windows paths (5ms)',
    '  Error: boom',
    '      at file:///repo/test/parsers.test.ts:73:5',
  ].join('\n');
  const f = parseSpec(out, CWD, 'test');
  assert.equal(f.length, 1);
  assert.equal(norm(f[0].file), '/repo/test/parsers.test.ts');
  assert.equal(f[0].line, 73);
});

test('lines parser separates file-prefixed lines from plain messages', () => {
  const out = [
    'README.md: version 0.1.0 does not match 0.2.0 in package.json',
    'version-drift: no release channel declared',
  ].join('\n');
  const f = parseLines(out, CWD, 'version');

  assert.equal(f.length, 2);
  assert.equal(norm(f[0].file), '/repo/README.md');
  assert.ok(f[0].summary.includes('0.1.0'));
  assert.equal(f[1].file, undefined);
  assert.ok(f[1].summary.includes('release channel'));
});

test('strict parser reads a pytest --tb=line failure', () => {
  // `pytest -q --tb=line` emits `path:line: message` per failure — the
  // message is already on the finding line, so no further enrichment.
  const out = [
    '_____________________________ test_tax_rate ______________________________',
    '',
    'E   assert 8 == 10',
    '    +  where 8 = apply_tax(100)',
    'test_pricing.py:7: assert 8 == 10',
    '=========================== short test summary info ===========================',
    'FAILED test_pricing.py::test_tax_rate - assert 8 == 10',
    '1 failed, 1 passed in 0.05s',
  ].join('\n');
  const f = parseStrict(out, CWD, 'py:test');

  assert.equal(f.length, 1);
  assert.equal(norm(f[0].file), '/repo/test_pricing.py');
  assert.equal(f[0].line, 7);
  assert.equal(f[0].summary, 'assert 8 == 10');
});

test('strict parser reads a go test failure and skips FAIL banners', () => {
  const out = [
    '--- FAIL: TestTaxRate (0.00s)',
    '    pricing_test.go:25: expected 10, got 5',
    'FAIL',
    'FAIL\texample.com/tax\t0.023s',
  ].join('\n');
  const f = parseStrict(out, CWD, 'go:test');

  assert.equal(f.length, 1);
  assert.equal(norm(f[0].file), '/repo/pricing_test.go');
  assert.equal(f[0].line, 25);
  assert.equal(f[0].summary, 'expected 10, got 5');
});

test('strict parser skips traceback frames and footers', () => {
  // A `--tb=short`-style frame is scaffolding; only the real error line
  // becomes a finding. Footers are never findings.
  const out = [
    'test_pricing.py:7: in test_tax_rate',
    'E   assert 8 == 10',
    '',
    'test_pricing.py:7: AssertionError',
    '1 failed in 0.05s',
  ].join('\n');
  const f = parseStrict(out, CWD, 'py:test');

  assert.equal(f.length, 1);
  assert.equal(f[0].summary, 'AssertionError');
});

test('strict parser reads ruff concise and go vet with column numbers', () => {
  const ruff = parseStrict("src/foo.py:12:5: F401 [*] 'os' imported but unused", CWD, 'py:lint');
  assert.equal(ruff.length, 1);
  assert.equal(norm(ruff[0].file), '/repo/src/foo.py');
  assert.equal(ruff[0].line, 12);
  assert.equal(ruff[0].evidence.col, 5);
  assert.equal(ruff[0].summary, "F401 [*] 'os' imported but unused");

  const vet = parseStrict('./foo.go:12:2: fmt.Println is unused', CWD, 'go:vet');
  assert.equal(vet.length, 1);
  assert.equal(norm(vet[0].file), '/repo/foo.go');
  assert.equal(vet[0].line, 12);
  assert.equal(vet[0].evidence.col, 2);
});

test('strict parser drops outside-root paths and non-file noise', () => {
  const out = [
    'C:/Users/me/AppData/Local/site-packages/foo.py:12: boom',
    '=== RUN   TestFoo',
    'ok  example.com/tax  0.023s',
  ].join('\n');
  assert.equal(parseStrict(out, CWD, 'go:test').length, 0);
});

test('strict parser drops venv and site-packages findings even inside the root', () => {
  // A real run surfaced phantoms from `.venv/Lib/site-packages/…`: the
  // path passes the outside-root check (it IS under the root) but is not
  // repo code. Venv dirs and package dirs must be skipped anywhere.
  const root = resolve(CWD).replace(/\\/g, '/');
  const out = [
    `${root}/.venv/Lib/site-packages/jwt/api_jwt.py:147: InsecureKeyLengthWarning: Key is too short`,
    `${root}/.venv/Lib/site-packages/jwt/api_jwt.py:365: InsecureKeyLengthWarning: Key is too short`,
    `${root}/venv/lib/python3.12/site-packages/x/y.py:9: boom`,
    `${root}/src/foo.py:12:5: F401 'os' imported but unused`,
  ].join('\n');
  const f = parseStrict(out, root, 'py:lint');

  assert.equal(f.length, 1);
  assert.equal(norm(f[0].file), '/repo/src/foo.py');
});

test('strict parser ignores pytest warnings summary lines', () => {
  // The `warnings summary` block shares the `path:line: Type: message`
  // shape with real findings, but warnings are not the failure the check
  // reports — a noisy suite must not surface them as phantom defects.
  const out = [
    'src/tax.py:7: assert 8 == 10',
    '==== warnings summary ====',
    'src/api.py:12: DeprecationWarning: old API used',
    'src/api.py:13: pytest.PytestUnhandledCoroutineWarning: coroutine not awaited',
    'src/api.py:14: UserWarning: unknown',
  ].join('\n');
  const f = parseStrict(out, CWD, 'py:test');

  assert.equal(f.length, 1);
  assert.equal(f[0].summary, 'assert 8 == 10');
});

test('strict parser reads a drive-letter path anchored inside the root', () => {
  // The drive-letter spelling is a Windows shape; on POSIX the same content
  // is plain `/repo/…`. Deriving both from resolve(CWD) keeps the assertion
  // valid on every OS (the convention the tap location test uses).
  const root = resolve(CWD).replace(/\\/g, '/');
  const f = parseStrict(`${root}/src/tax.py:4: F401 'os' imported but unused`, root, 'py:lint');
  assert.equal(f.length, 1);
  assert.equal(norm(f[0].file), '/repo/src/tax.py');
  assert.equal(f[0].line, 4);
});

test('rust parser reads a cargo test panic frame', () => {
  const out = [
    'running 2 tests',
    'test tests::test_applies_tax ... FAILED',
    '',
    'failures:',
    '',
    '---- tests::test_applies_tax stdout ----',
    "thread 'tests::test_applies_tax' panicked at src/lib.rs:8:5:",
    'assertion `left == right` failed',
    '  left: 8.0,',
    ' right: 10',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
    '',
    'failures:',
    '    tests::test_applies_tax',
    '',
    'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s',
  ].join('\n');
  const f = parseRust(out, CWD, 'rs:test');

  assert.equal(f.length, 1);
  assert.equal(norm(f[0].file), '/repo/src/lib.rs');
  assert.equal(f[0].line, 8);
  assert.equal(f[0].summary, 'assertion `left == right` failed');
});

test('rust parser pairs clippy warnings with their --> location', () => {
  const out = [
    'warning: unused import: `std::fmt`',
    ' --> src/lib.rs:2:5',
    '  |',
    '2 | use std::fmt;',
    '  |     ^^^^^^^^^',
    '  |',
    '  = help: remove it',
  ].join('\n');
  const [f] = parseRust(out, CWD, 'rs:lint');

  assert.equal(f.code, 'unused_imports');
  assert.equal(norm(f.file), '/repo/src/lib.rs');
  assert.equal(f.line, 2);
  assert.equal(f.evidence.col, 5);
  assert.ok(f.summary.includes('unused import'));
});

test('rust parser reads a denied lint (`-D warnings`) printed as error:', () => {
  const out = [
    'error: unused import: `std::fmt`',
    ' --> src/lib.rs:1:5',
    '  |',
    '1 | use std::fmt;',
    '  |     ^^^^^^^^^',
  ].join('\n');
  const [f] = parseRust(out, CWD, 'rs:lint');

  assert.equal(f.code, 'unused_imports');
  assert.equal(f.line, 1);
});

test('rust parser reads rustc compile errors in default format', () => {
  const out = [
    'error[E0425]: cannot find value `x` in this scope',
    ' --> src/lib.rs:5:17',
    '  |',
    '5 |     let y = x;',
    '  |             ^',
  ].join('\n');
  const [f] = parseRust(out, CWD, 'rs:test');

  assert.equal(f.code, 'E0425');
  assert.equal(norm(f.file), '/repo/src/lib.rs');
  assert.equal(f.line, 5);
});

test('rust parser reads clippy short format (one line per diagnostic)', () => {
  const out = 'src/lib.rs:2:5: warning: unused import: `std::fmt`';
  const [f] = parseRust(out, CWD, 'rs:lint');

  assert.equal(f.code, 'unused_imports');
  assert.equal(norm(f.file), '/repo/src/lib.rs');
  assert.equal(f.line, 2);
});

test('rust parser ignores value lines, notes and unanchored noise', () => {
  const out = [
    '  left: 8.0,',
    ' right: 10',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
    'test result: FAILED. 1 passed; 1 failed',
    '  = help: remove it',
  ].join('\n');
  assert.equal(parseRust(out, CWD, 'rs:test').length, 0);
});

test('fingerprints are stable across numbers but differ by defect', () => {
  const a = parseTsc('src/a.ts(1,1): error TS2307: Cannot find module \'./x\'.', CWD, 'typecheck');
  const b = parseTsc('src/a.ts(9,9): error TS2307: Cannot find module \'./x\'.', CWD, 'typecheck');
  const c = parseTsc('src/a.ts(1,1): error TS2307: Cannot find module \'./y\'.', CWD, 'typecheck');
  assert.equal(a[0].fingerprint, b[0].fingerprint);
  assert.notEqual(a[0].fingerprint, c[0].fingerprint);
});
