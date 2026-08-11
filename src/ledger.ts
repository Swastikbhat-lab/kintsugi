import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Attempt, Patch, Finding } from './types.js';

/**
 * Where a target's ledger lives.
 *
 * Deliberately *not* inside the target repo. Kintsugi is pointed at codebases
 * it does not own, and dropping an untracked directory into someone's working
 * tree is not ours to make. Keyed by the absolute source root so each target
 * keeps its own history.
 */
export function ledgerPathFor(sourceRoot: string): string {
  const key = createHash('sha1').update(resolve(sourceRoot)).digest('hex').slice(0, 16);
  return join(homedir(), '.kintsugi', 'ledgers', `${key}.json`);
}

/**
 * The ledger is the only reason this system improves rather than just repeats.
 *
 * Every repair attempt is recorded against the finding's fingerprint together
 * with what actually happened to it. On the next encounter with the same
 * fingerprint the engine consults the ledger before proposing anything:
 *
 *   - a patch shape that previously committed is tried first
 *   - a patch shape that previously regressed or was ineffective is skipped
 *
 * Without this the loop rediscovers the same dead end on every run, which is
 * the failure mode that makes naive auto-fixers oscillate.
 */
export class Ledger {
  private attempts: Attempt[] = [];

  constructor(private path: string) {
    if (existsSync(path)) {
      try {
        this.attempts = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        // A corrupt ledger must not take the run down. Start clean; the
        // worst case is that we re-learn what we already knew.
        this.attempts = [];
      }
    }
  }

  record(attempt: Attempt): void {
    this.attempts.push(attempt);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.attempts, null, 2));
  }

  /** Everything previously tried for this exact defect. */
  history(fingerprint: string): Attempt[] {
    return this.attempts.filter((a) => a.fingerprint === fingerprint);
  }

  /**
   * A patch is worth trying if we have not already proven it does not work.
   * Identity is (file, find, replace) — the same edit, not the same wording
   * of the rationale.
   */
  shouldTry(fingerprint: string, patch: Patch): boolean {
    return !this.history(fingerprint).some(
      (a) =>
        a.outcome !== 'committed' &&
        a.patch.file === patch.file &&
        a.patch.find === patch.find &&
        a.patch.replace === patch.replace,
    );
  }

  /**
   * Order candidate patches by what the ledger has learned. Patches whose
   * exact shape has committed before go first; the rest keep their order.
   */
  prioritise(fingerprint: string, candidates: Patch[]): Patch[] {
    const proven = new Set(
      this.attempts
        .filter((a) => a.outcome === 'committed')
        .map((a) => `${a.patch.find}\u0000${a.patch.replace}`),
    );
    const viable = candidates.filter((p) => this.shouldTry(fingerprint, p));
    return [
      ...viable.filter((p) => proven.has(`${p.find}\u0000${p.replace}`)),
      ...viable.filter((p) => !proven.has(`${p.find}\u0000${p.replace}`)),
    ];
  }

  /**
   * Findings we have repeatedly failed to fix are quarantined rather than
   * retried forever — they surface to the human instead of burning
   * iterations.
   */
  isExhausted(f: Finding, limit = 3): boolean {
    const tried = this.history(f.fingerprint);
    if (!tried.length) return false;
    // Once we have run out of candidate patches there is nothing left to
    // learn by looping again — the next pass would propose the same empty
    // set. Quarantine immediately rather than burning the iteration budget.
    // Only a *provider-backed* dead end counts: a rules-only run records
    // `patch.id === 'none'` for findings no mechanical rule reaches, which
    // proves nothing about what a model could propose — it must not blind
    // a later run that has a model configured.
    if (tried.some((a) => a.patch.id === 'none' && a.provider)) return true;
    return tried.length >= limit && !tried.some((a) => a.outcome === 'committed');
  }

  all(): Attempt[] {
    return [...this.attempts];
  }
}
