import type { Attempt, Finding, RunState } from './types.js';
import { relative, resolve } from 'node:path';

/** How a remaining finding fared: was there a repair, and did it ship? */
export type FindingRepairStatus =
  | 'applied'      // fixed and verified (should not appear in remaining findings)
  | 'proposed'     // dry run: a mechanical repair exists, nothing applied
  | 'escalated'    // a repair exists but touches a shared file — a human decision
  | 'attempted'    // tried and disproved by the checks (ineffective / regressed / rejected)
  | 'none';        // no mechanical repair exists — quarantined for a human

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
  /** Everything still wrong after the run, with its repair status. */
  findings: Array<Finding & { repair: FindingRepairStatus }>;
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

  // A finding that survives to the report answers "was there a repair?" from
  // the attempt ledger (live runs) or from the dry survey's stamp.
  const repairByFingerprint = new Map<string, FindingRepairStatus>();
  for (const a of committed) repairByFingerprint.set(a.fingerprint, 'applied');
  for (const a of reverted) repairByFingerprint.set(a.fingerprint, 'attempted');
  for (const a of rejected) repairByFingerprint.set(a.fingerprint, 'attempted');
  for (const a of escalated) repairByFingerprint.set(a.fingerprint, 'escalated');
  for (const a of quarantined) repairByFingerprint.set(a.fingerprint, 'none');

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
    findings: state.findings.map((f) => {
      // The dry survey's vocabulary differs from the report's: it says
      // `patchable`, the report says `proposed` (nothing was applied).
      const dry: FindingRepairStatus | undefined =
        f.dryStatus === 'patchable' ? 'proposed' : f.dryStatus;
      return {
        ...f,
        repair: dry ?? repairByFingerprint.get(f.fingerprint) ?? 'none',
      };
    }),
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
  const finding = (f: Finding) => ({
    check: f.check,
    severity: f.severity,
    summary: f.summary,
    file: f.file ? rel(f.file) : undefined,
    line: f.line,
    code: f.code,
    repair: (f as Finding & { repair?: FindingRepairStatus }).repair ?? 'none',
  });
  return {
    runId: s.runId,
    status: s.status,
    iterations: s.iterations,
    committed: s.committed.map((a) => ({ rationale: a.patch.rationale, file: rel(a.patch.file) })),
    reverted: s.reverted.map((a) => ({ outcome: a.outcome, rationale: a.patch.rationale, file: rel(a.patch.file) })),
    escalated: s.escalated.map((a) => ({ rationale: a.patch.rationale, file: rel(a.patch.file) })),
    quarantined: s.quarantined.map((a) => ({ finding: a.fingerprint })),
    findings: s.findings.map(finding),
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
