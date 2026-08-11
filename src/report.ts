import type { Attempt, Finding, RunState } from './types.js';
import { relative, resolve } from 'node:path';

/**
 * The final report. Distinct buckets, each with a reason to exist:
 *
 *   committed   — applied, verified, kept. The work.
 *   reverted    — tried and disproved by the checks (ineffective, regressed).
 *   escalated   — a real patch existed but touched a shared file, so it was
 *                 reported instead of applied. A decision, not a failure.
 *   rejected    — the critic agents voted it down before it was ever applied.
 *   quarantined — no candidate patch exists at all; surfaced for a human.
 */
export interface Summary {
  runId: string;
  status: string;
  iterations: number;
  committed: Attempt[];
  reverted: Attempt[];
  escalated: Attempt[];
  rejected: Attempt[];
  quarantined: Attempt[];
  findingsRemaining: number;
  actionableRemaining: number;
}

export function summarise(state: RunState, actionableRemaining: Finding[]): Summary {
  const attempts = state.attempts;
  const committed = attempts.filter((a) => a.outcome === 'committed');
  const reverted = attempts.filter((a) => a.outcome === 'ineffective' || a.outcome === 'regressed');
  const unverifiable = attempts.filter((a) => a.outcome === 'unverifiable');
  const quarantined = unverifiable.filter((a) => a.patch.id === 'none');
  const withPatch = unverifiable.filter((a) => a.patch.id !== 'none');
  const escalated = withPatch.filter((a) => a.patch.scope === 'shared');
  const rejected = withPatch.filter((a) => a.patch.scope !== 'shared');

  return {
    runId: state.id,
    status: state.status,
    iterations: state.iteration,
    committed,
    reverted,
    escalated,
    rejected,
    quarantined,
    findingsRemaining: state.findings.length,
    actionableRemaining: actionableRemaining.length,
  };
}

export function summaryLines(s: Summary, sourceRoot: string): string[] {
  const rel = (f: string) => relative(resolve(sourceRoot), resolve(f)).replace(/\\/g, '/');
  const lines: string[] = [];

  lines.push(`${s.status.toUpperCase()} after ${s.iterations} iteration(s)`);
  lines.push(`${s.committed.length} committed · ${s.reverted.length} reverted · ` +
    `${s.escalated.length} escalated · ${s.rejected.length} rejected · ${s.quarantined.length} quarantined`);
  lines.push(`${s.actionableRemaining} actionable finding(s) remaining`);

  for (const a of s.committed) {
    lines.push(`✓ ${a.patch.rationale}${a.patch.file ? `  (${rel(a.patch.file)})` : ''}`);
  }
  for (const a of s.escalated) {
    lines.push(`↥ ESCALATED ${a.patch.rationale}  (${rel(a.patch.file)})`);
  }
  for (const a of s.quarantined) {
    lines.push(`? ${a.patch.rationale}`);
  }
  return lines;
}

export function reportJson(s: Summary, sourceRoot: string) {
  const rel = (f: string) => relative(resolve(sourceRoot), resolve(f)).replace(/\\/g, '/');
  return {
    runId: s.runId,
    status: s.status,
    iterations: s.iterations,
    committed: s.committed.map((a) => ({ rationale: a.patch.rationale, file: rel(a.patch.file) })),
    reverted: s.reverted.map((a) => ({ outcome: a.outcome, rationale: a.patch.rationale, file: rel(a.patch.file) })),
    escalated: s.escalated.map((a) => ({ rationale: a.patch.rationale, file: rel(a.patch.file) })),
    quarantined: s.quarantined.map((a) => ({ finding: a.fingerprint })),
    findingsRemaining: s.findingsRemaining,
    actionableRemaining: s.actionableRemaining,
  };
}

/** 0 when nothing actionable remains (or only quarantined, with --quarantined-ok). */
export function exitCodeFor(s: Summary, quarantinedOk: boolean): number {
  if (s.findingsRemaining === 0) return 0;
  if (quarantinedOk && s.actionableRemaining === 0) return 0;
  return 1;
}
