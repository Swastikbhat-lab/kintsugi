import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskOf, byRisk, suppressFindings } from '../src/risk.js';
import type { Finding } from '../src/types.js';

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

test('riskOf: security beats style; import cleanup is cheap', () => {
  const secret = riskOf(finding({ code: 'B105', summary: 'B105 hardcoded password', evidence: { message: 'B105 hardcoded password' } }));
  assert.equal(secret.impact, 9);
  assert.equal(secret.likelihood, 9);
  assert.equal(secret.level, 'CRITICAL');

  const unused = riskOf(finding({ code: 'F401', summary: "F401 'os' imported but unused", evidence: { message: "F401 'os' imported but unused" } }));
  assert.equal(unused.fixCost, 1);
  assert.ok(unused.score < secret.score);

  const complex = riskOf(finding({ code: 'CC_C', summary: 'cyclomatic complexity C (11): f', evidence: { message: 'cyclomatic complexity C (11): f' } }));
  assert.equal(complex.fixCost, 9);
});

test('byRisk: worst severity first, then highest risk, ties keep insertion order', () => {
  const blocker = finding({ check: 'py:test', severity: 'blocker', summary: 'assert 8.0 == 10', evidence: { message: 'assert 8.0 == 10' } });
  const secret = finding({ code: 'B105', summary: 'B105 hardcoded password', evidence: { message: 'B105 hardcoded password' } });
  const unused = finding({ code: 'F401', summary: "F401 'os' imported but unused", evidence: { message: "F401 'os' imported but unused" } });
  const todo = finding({ code: 'T101', summary: 'T101 TODO/FIXME comment found', evidence: { message: 'T101 TODO/FIXME comment found' } });

  const sorted = [todo, unused, secret, blocker].sort(byRisk);
  assert.deepEqual(sorted, [blocker, secret, unused, todo]);

  // Ties (identical scores) keep stable insertion order — the contract the
  // two engines' parity depends on.
  const a = finding({ code: 'F401', summary: "F401 'a' imported but unused", evidence: { message: "F401 'a' imported but unused" } });
  const b = finding({ code: 'I001', summary: 'I001 Import block is un-sorted', evidence: { message: 'I001 Import block is un-sorted' } });
  assert.deepEqual([b, a].sort(byRisk), [b, a]);
});

test('suppressFindings: generated, test-file style, and expected domain complexity are dropped, real failures never', () => {
  const generated = finding({ file: '/repo/src/app_gen.py', code: 'F401', summary: "F401 'os' imported but unused", evidence: { message: "F401 'os' imported but unused" } });
  const migrations = finding({ file: '/repo/migrations/0001.py', code: 'T101', summary: 'T101 TODO/FIXME comment found', evidence: { message: 'T101 TODO/FIXME comment found' } });
  const testStyle = finding({ file: '/repo/tests/test_app.py', code: 'T102', summary: 'T102 use logging instead of print', evidence: { message: 'T102 use logging instead of print' } });
  const testFailure = finding({ file: '/repo/tests/test_tax.py', code: undefined, check: 'py:test', severity: 'blocker', summary: 'assert 8.0 == 10', evidence: { message: 'assert 8.0 == 10' } });
  const product = finding({ file: '/repo/src/app.py', code: 'T201', summary: 'T201 use isinstance() instead of type()==', evidence: { message: 'T201 use isinstance() instead of type()==' } });
  // Complexity in a domain-heavy file is expected, not a defect (CodeGuardian's
  // suppress_domain_complexity) — but the same code in business logic stays actionable.
  const domain = finding({ file: '/repo/src/json_parser.py', code: 'CC_D', summary: 'cyclomatic complexity D (15): parse', evidence: { message: 'cyclomatic complexity D (15): parse' } });
  const plain = finding({ file: '/repo/src/billing.py', code: 'CC_D', summary: 'cyclomatic complexity D (15): apply_tax', evidence: { message: 'cyclomatic complexity D (15): apply_tax' } });

  const { kept, dropped } = suppressFindings([generated, migrations, testStyle, testFailure, product, domain, plain]);
  assert.deepEqual(dropped, [generated, migrations, testStyle, domain]);
  assert.deepEqual(kept, [testFailure, product, plain]);
});
