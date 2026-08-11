import type { CheckDef, CheckResult, Finding, Outcome } from './types.js';
import { runCheck } from './checks.js';

export interface VerifyResult {
  outcome: Outcome;
  cleared: boolean;
  collateral: Finding[];
  runs: CheckResult[];
}

/**
 * The verify gate — the load-bearing phase of the whole loop.
 *
 * After a patch is applied, every check is re-run. The patch is kept only if
 * the target finding is gone **and** nothing new appeared. A repair loop
 * without this step will confidently apply changes that do nothing, and a
 * loop that skips the collateral check trades one defect for two.
 *
 * A check that crashes during verification proves nothing, so it cannot
 * count as success: that outcome is `unverifiable` and the patch is
 * reverted, because a broken harness must not be able to rubber-stamp an
 * edit.
 */
export async function verifyPatch(
  checks: CheckDef[],
  sourceRoot: string,
  baseline: Set<string>,
  targetFingerprint: string,
): Promise<VerifyResult> {
  const runs = await Promise.all(checks.map((c) => runCheck(c, sourceRoot)));
  const after = runs.flatMap((r) => r.findings);
  const crashed = runs.some((r) => r.crashed);

  const cleared = !after.some((f) => f.fingerprint === targetFingerprint);
  const collateral = after.filter((f) => !baseline.has(f.fingerprint));

  let outcome: Outcome;
  if (crashed) outcome = 'unverifiable';
  else if (cleared && collateral.length === 0) outcome = 'committed';
  else if (cleared) outcome = 'regressed';
  else outcome = 'ineffective';

  return { outcome, cleared, collateral, runs };
}
