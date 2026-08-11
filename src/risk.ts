import type { Finding } from './types.js';

/**
 * Risk scoring + suppression — the prioritization layer over the finding
 * queue, harvested from CodeGuardian's review model.
 *
 * Risk scoring: every finding gets a deterministic 0-10 score from four
 * dimensions (impact, likelihood, fix cost, blast radius), so the loop
 * targets the *worst* defect first within a severity band rather than
 * whatever the tool happened to print first.
 *
 * Suppression: a small set of context rules drops findings that are almost
 * always false positives for a *repair* tool — code that is generated (nobody
 * should patch machine output by hand) and style findings inside test files
 * (where relaxed rules are conventional). Real test *failures* are never
 * suppressed: only style codes (T/P/CC) are, never `py:test` results.
 *
 * The scoring is a pure function of the finding, and both engines share the
 * exact same arithmetic — so the ordering they converge in is identical.
 */

export interface RiskScore {
  score: number;
  level: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL';
  impact: number;
  likelihood: number;
  fixCost: number;
  scope: number;
}

const SECURITY = /^B\d{3}$/;
const COMPLEXITY = /^CC_[CDEF]$/;
const PERF = /^P\d{3}$/;
const FIXABLE = /^(T201|T202|T203|T001|T105|B105|B324)$/;
const IMPORT = /^(F401|I001|unused_imports)$/;
const HARDCODED = /hardcoded (password|secret|key|token)|api[_-]?key|aws[_-]?secret/;

export function riskOf(f: Finding): RiskScore {
  const code = f.code ?? '';
  const severity = f.severity;
  const message = `${f.summary} ${f.evidence.message ?? ''}`.toLowerCase();

  // Impact: how bad is it when this defect actually bites.
  let impact: number;
  if (SECURITY.test(code) || HARDCODED.test(message)) impact = 9;
  else if (severity === 'blocker') impact = 8;
  else if (severity === 'major') impact = 6;
  else if (COMPLEXITY.test(code)) impact = 5;
  else impact = 3;

  // Likelihood: how often it will actually fire.
  let likelihood: number;
  if (SECURITY.test(code)) likelihood = 9;
  else if (f.check.endsWith(':test') && /assert |== |!= |expected /.test(message)) likelihood = 8;
  else if (COMPLEXITY.test(code) || PERF.test(code)) likelihood = 6;
  else likelihood = 3;

  // Fix cost: 1 = trivial mechanical edit, 10 = deep rewrite.
  let fixCost: number;
  if (COMPLEXITY.test(code)) fixCost = 9;
  else if (SECURITY.test(code)) fixCost = 8;
  else if (FIXABLE.test(code)) fixCost = 2;
  else if (IMPORT.test(code)) fixCost = 1;
  else fixCost = 4;

  // Scope: how much of the codebase a wrong fix could touch.
  let scope: number;
  if (SECURITY.test(code)) scope = 8;
  else if (severity === 'blocker') scope = 5;
  else scope = 3;

  const score = impact * 0.4 + likelihood * 0.3 + scope * 0.2 + (10 - fixCost) * 0.1;
  const level: RiskScore['level'] = score >= 8 ? 'CRITICAL' : score >= 6 ? 'HIGH' : score >= 4 ? 'MEDIUM' : score >= 2 ? 'LOW' : 'MINIMAL';
  return { score: Math.round(score * 100) / 100, level, impact, likelihood, fixCost, scope };
}

const RANK = { blocker: 0, major: 1, minor: 2 } as const;

/**
 * Worst first: severity band, then risk score descending, then stable
 * insertion order (Array.prototype.sort is stable, so ties keep the order
 * the observers produced — identical in both engines).
 */
export function byRisk(a: Finding, b: Finding): number {
  const d = RANK[a.severity] - RANK[b.severity];
  if (d !== 0) return d;
  return riskOf(b).score - riskOf(a).score;
}

// ------------------------------------------------------------- suppression

const GENERATED = /generated|_gen\.|migrations\/|vendor\//i;
const STYLE = /^(T\d{3}|P\d{3}|CC_[A-F])$/;
const TEST_FILE = /(?:^|[/\\])test_[^/\\]*\.py$|(?:^|[/\\])[^/\\]*_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$/;
// Complexity is expected in domain-heavy files (a parser, a crypto wrapper, a
// transform pipeline) — a CC finding there is not a defect a repair loop can
// act on, and it would otherwise squat at the top of the queue forever.
const DOMAIN_FILE = /parser|model|crypto|transform/i;
const COMPLEXITY_CODE = /^CC_[A-F]$/;

export function suppressFindings(
  findings: Finding[],
): { kept: Finding[]; dropped: Finding[] } {
  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  for (const f of findings) {
    const file = f.file ?? '';
    const code = f.code ?? '';
    const generated = GENERATED.test(file);
    const testStyle = TEST_FILE.test(file) && STYLE.test(code);
    const domainComplexity = COMPLEXITY_CODE.test(code) && DOMAIN_FILE.test(file);
    if (generated || testStyle || domainComplexity) dropped.push(f);
    else kept.push(f);
  }
  return { kept, dropped };
}
