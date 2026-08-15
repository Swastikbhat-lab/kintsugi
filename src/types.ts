/**
 * Domain model for the generalized loop.
 *
 * The v1 model measured a rendered web interface. This one measures anything
 * a check command can report: test failures, type errors, lint violations,
 * build output, custom scripts. The loop that consumes the model is
 * unchanged — observe, diagnose, repair, verify, settle.
 */

// ------------------------------------------------------------- findings

export type Severity = 'blocker' | 'major' | 'minor';

/** One defect reported by one check run. */
export interface Finding {
  /** Stable across runs for the same defect — what the ledger keys on. */
  fingerprint: string;
  /** The check that produced it (config name). */
  check: string;
  severity: Severity;
  summary: string;
  /** Absolute path to the owning source file, when the check knows one. */
  file?: string;
  line?: number;
  /** Machine code from the tool, e.g. TS2307. */
  code?: string;
  /** Parsed specifics the healer needs to construct a patch. */
  evidence: Record<string, unknown>;
  /**
   * Stamped during a dry-run survey: whether a mechanical repair exists for
   * this finding. Lets a CI report say "repair available" without applying
   * anything. Unset on live runs, where the attempt record answers instead.
   */
  dryStatus?: 'patchable' | 'escalated' | 'none';
}

// ------------------------------------------------------------- repair

/** One exact string replacement in one file. No regex, no ambiguity. */
export interface Edit {
  file: string;
  find: string;
  replace: string;
  /**
   * Create the file with `replace` as its content instead of editing an
   * existing one (test generation). The target must not already exist;
   * reverting deletes the file again. `find` is unused and must be empty.
   */
  create?: boolean;
}

export interface Patch extends Edit {
  id: string;
  rationale: string;
  /**
   * Further edits that only make sense together with the primary one. They
   * are applied and reverted as a unit, and the verify step sees one change.
   * Most patches have none.
   */
  also?: Edit[];
  /**
   * Blast radius, decided from what the file is, not from the patch:
   *
   * `local` — one file, one defect. Safe to apply and verify.
   * `shared` — a file other modules import. Changing it moves code the loop
   *   was not looking at, so it is reported and never applied automatically.
   *   The verify gate cannot catch this: the finding genuinely clears, and
   *   the damage lands somewhere else.
   */
  scope: 'local' | 'shared';
  /** Number of importers, when known. */
  blastRadius?: number;
}

export type Outcome = 'committed' | 'ineffective' | 'regressed' | 'unverifiable';

export interface Attempt {
  fingerprint: string;
  patch: Patch;
  outcome: Outcome;
  at: string;
  /** Findings that appeared as a direct result of this patch. */
  collateral: string[];
  /**
   * Whether a model/mock proposer was available when this attempt was
   * recorded. A rules-only run records `patch.id === 'none'` for findings
   * no mechanical rule reaches — that proves nothing about what a model
   * could propose, so it must not permanently exhaust the finding.
   */
  provider?: boolean;
}

// ------------------------------------------------------------- checks

/** How a check's output is turned into findings. */
export type ParserKind = 'tsc' | 'tap' | 'lines' | 'strict' | 'rust' | 'radon';

export interface CheckDef {
  name: string;
  /** Shell command, run with cwd = source root. */
  command: string;
  parser: ParserKind;
  severity?: Severity;
  /** Repair-attempt budget per finding from this check. */
  budget?: number;
  /** Only findings with these codes are kept — a check owns its defect class. */
  filterCodes?: string[];
  /**
   * Longer than the 120s default for toolchains that cold-build on first
   * run (cargo compiles the crate and its deps before testing/linting).
   */
  timeoutMs?: number;
  /**
   * Parse findings from the output even when the command exits 0. Most
   * tools reserve a non-zero exit for "found something", but analysis
   * tools like radon always exit 0 — their findings are in the text, not
   * the status. (A check with this flag that exits 0 with no parseable
   * output is simply clean, never crashed.)
   */
  parseOnExit0?: boolean;
}

export interface CheckResult {
  check: string;
  findings: Finding[];
  exitCode: number;
  durationMs: number;
  /**
   * The check failed in a way that produced no parseable findings — a crash,
   * a killed process, a broken harness. Distinct from a defect: the loop
   * never heals a check that merely errored.
   */
  crashed: boolean;
  output: string;
}

// ------------------------------------------------------------- config

export interface RunConfig {
  /** Repo root under audit. Checks run here; patches cannot leave it. */
  sourceRoot: string;
  checks: CheckDef[];
  /** Default per-finding repair budget (checks may override). */
  budget: number;
  /** Hard stop, so a loop that cannot converge cannot run forever. */
  maxIterations: number;
  /** Survey only — compute and report patches, write nothing. */
  dryRun: boolean;
  /** Permit patches on shared files (escalated by default). */
  allowShared: boolean;
  /** Ledger path override (defaults to ~/.kintsugi/ledgers/<key>.json). */
  statePath?: string;
  /** Append one NDJSON line per repair attempt plus a run summary. */
  auditLog?: string;
  /** Replay canned proposals instead of calling a model (demo, tests). */
  llmMock?: string;
  /**
   * Inject a provider directly (tests). When unset the loop builds one
   * from llmMock or the installed SDK. Mirrors the Python engine, whose
   * config accepts the same injection.
   */
  provider?: import('./provider.js').Provider;
  /** Commit each verified patch on a branch of its own. */
  git?: boolean;
  /** Branch to work on in git mode. */
  branch?: string;
  /** Push the fix branch after the run (the pusher role; requires git mode). */
  push?: boolean;
  /** Exit 0 when the only remaining findings are quarantined. */
  quarantinedOk?: boolean;
}

// ------------------------------------------------------------- loop

export type Phase = 'observe' | 'diagnose' | 'repair' | 'verify' | 'settle';

export interface LoopEvent {
  runId: string;
  iteration: number;
  phase: Phase;
  at: string;
  message: string;
  data?: unknown;
}

export interface RunState {
  id: string;
  config: RunConfig;
  findings: Finding[];
  attempts: Attempt[];
  iteration: number;
  status: 'idle' | 'running' | 'converged' | 'exhausted' | 'failed';
  startedAt: string;
  endedAt?: string;
}
