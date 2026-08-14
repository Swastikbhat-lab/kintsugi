import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, reportJson } from '../src/report.js';
import type { Finding, Patch, RunConfig, RunState } from '../src/types.js';

const config: RunConfig = {
  sourceRoot: '/repo',
  checks: [],
  budget: 1,
  maxIterations: 3,
  dryRun: false,
  allowShared: false,
};

const patch: Patch = {
  id: 'p',
  file: '/repo/src/a.ts',
  find: 'a',
  replace: 'b',
  rationale: 'r',
  scope: 'local',
};

function state(findings: Finding[], attempts: RunState['attempts'] = []): RunState {
  return {
    id: 'abc123',
    config,
    findings,
    attempts,
    iteration: 1,
    status: 'converged',
    startedAt: '2024-01-01T00:00:00Z',
  };
}

test('dry-run survey stamps map to "proposed" in the summary', () => {
  const finding: Finding = {
    fingerprint: 'f1', check: 'typecheck', severity: 'major', summary: 'x',
    file: '/repo/src/a.ts', code: 'TS2307', evidence: {}, dryStatus: 'patchable',
  };
  const s = summarise(state([finding]), []);
  assert.equal(s.findings[0].repair, 'proposed');
  assert.equal(s.findingsRemaining, 1);
});

test('a shared-file repair is reported as "escalated", not proposed', () => {
  const finding: Finding = {
    fingerprint: 'f1', check: 'typecheck', severity: 'major', summary: 'x',
    file: '/repo/src/a.ts', code: 'TS2307', evidence: {}, dryStatus: 'escalated',
  };
  const s = summarise(state([finding]), []);
  assert.equal(s.findings[0].repair, 'escalated');
});

test('a finding with no mechanical repair is "none" (quarantined)', () => {
  const finding: Finding = {
    fingerprint: 'f1', check: 'test', severity: 'blocker', summary: 'boom',
    evidence: {}, dryStatus: 'none',
  };
  const s = summarise(state([finding]), []);
  assert.equal(s.findings[0].repair, 'none');
});

test('live runs derive repair status from the attempt ledger', () => {
  const finding: Finding = {
    fingerprint: 'f2', check: 'typecheck', severity: 'minor', summary: 'y',
    file: '/repo/src/a.ts', evidence: {},
  };
  const attempts: RunState['attempts'] = [
    { fingerprint: 'f2', patch, outcome: 'ineffective', at: 't', collateral: [] },
  ];
  const s = summarise(state([finding], attempts), []);
  assert.equal(s.findings[0].repair, 'attempted');

  const escalated = summarise(state([finding], [
    { fingerprint: 'f2', patch: { ...patch, scope: 'shared' }, outcome: 'unverifiable', at: 't', collateral: [] },
  ]), []);
  assert.equal(escalated.findings[0].repair, 'escalated');

  const none = summarise(state([finding], [
    { fingerprint: 'f2', patch: { ...patch, id: 'none' }, outcome: 'unverifiable', at: 't', collateral: [] },
  ]), []);
  assert.equal(none.findings[0].repair, 'none');
});

test('reportJson carries per-finding detail with repo-relative paths', () => {
  const finding: Finding = {
    fingerprint: 'f3', check: 'lint', severity: 'blocker', summary: 'z',
    file: '/repo/src/b.ts', line: 3, code: 'TS6133', evidence: {}, dryStatus: 'patchable',
  };
  const s = summarise(state([finding]), []);
  const json = reportJson(s, '/repo');

  assert.equal(json.findings.length, 1);
  assert.equal(json.findings[0].file, 'src/b.ts');
  assert.equal(json.findings[0].repair, 'proposed');
  assert.equal(json.findings[0].code, 'TS6133');
  assert.equal(json.findings[0].severity, 'blocker');
  assert.equal(json.findings[0].line, 3);
});
