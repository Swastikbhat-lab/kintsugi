/**
 * Domain model. Everything in the system is a node in one graph, and every
 * change to that graph is produced by one loop iteration.
 */

// ---------------------------------------------------------------- graph

export type NodeKind = 'surface' | 'region' | 'signal';

/**
 * surface — an addressable screen (a route).
 * region  — a component subtree inside a surface, identified by a stable
 *           selector rather than by DOM position.
 * signal  — one measured property of a region (contrast ratio, overflow px).
 *           Signals are leaves; findings always hang off a signal.
 */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** surface: URL path. region: CSS selector. signal: detector id. */
  ref: string;
  parent?: string;
  /** Last observed value for signal nodes. Shape depends on the detector. */
  value?: unknown;
  /** Set when the most recent observation could not be trusted. See §unmeasurable. */
  unmeasurable?: string;
}

export type EdgeKind = 'contains' | 'navigates' | 'depends';

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface UIGraph {
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
}

// ---------------------------------------------------------------- findings

export type Severity = 'blocker' | 'major' | 'minor';

export interface Finding {
  /** Stable across runs for the same defect — this is what the ledger keys on. */
  fingerprint: string;
  nodeId: string;
  detector: string;
  severity: Severity;
  summary: string;
  /** Machine-readable specifics the healer needs to construct a patch. */
  evidence: Record<string, unknown>;
}

// ---------------------------------------------------------------- repair

export interface Patch {
  id: string;
  /** Absolute path to the source file this edits. */
  file: string;
  /** Exact string replacement — no regex, no ambiguity. */
  find: string;
  replace: string;
  rationale: string;
  /**
   * How far the blast radius reaches.
   *
   * `component` — one rule, one place. Safe to apply and verify.
   * `token` — a shared design token. Every use of it changes.
   * `global` — a bare element rule such as `a { }`. Every element of that
   *   kind in the product changes, which is the same blast radius as a token
   *   wearing different clothes.
   *
   * Anything other than `component` is reported and never applied
   * automatically, however cleanly it clears the measurement. The verify gate
   * cannot catch these: the finding genuinely does clear, and the damage
   * happens somewhere the loop was not looking.
   */
  scope?: 'component' | 'token' | 'global';
  /** Number of places the token is referenced, when known. */
  blastRadius?: number;
}

export type Outcome =
  /** Finding cleared, nothing new appeared. Patch kept. */
  | 'committed'
  /** Finding did not clear. Reverted. */
  | 'ineffective'
  /** Finding cleared but a new finding appeared. Reverted. */
  | 'regressed'
  /** Could not be verified either way — treated as failure, reverted. */
  | 'unverifiable';

export interface Attempt {
  fingerprint: string;
  patch: Patch;
  outcome: Outcome;
  at: string;
  /** Findings that appeared as a direct result of this patch. */
  collateral: string[];
}

// ---------------------------------------------------------------- loop

export type Phase =
  | 'observe'
  | 'diagnose'
  | 'repair'
  | 'verify'
  | 'settle';

export interface LoopEvent {
  runId: string;
  iteration: number;
  phase: Phase;
  at: string;
  message: string;
  data?: unknown;
}

export interface RunConfig {
  /** Base URL of the running app under repair. */
  target: string;
  /** Routes to walk. Each becomes a surface node. */
  routes: string[];
  /** Repo root the healers are allowed to edit. Nothing outside is touchable. */
  sourceRoot: string;
  /** Hard stop, so a loop that cannot converge cannot run forever. */
  maxIterations: number;
  /** When true, patches are computed and shown but never written to disk. */
  dryRun: boolean;
  /**
   * Permit patches that retint a shared design token. Off by default: such a
   * change moves the product everywhere the token is used, which is its
   * owner's call and not something a measurement can settle.
   */
  allowTokens?: boolean;
  /**
   * CDP endpoint of a browser the human already signed into. Without it the
   * tool launches its own, which can only reach pages that need no login.
   */
  attach?: string;
  /**
   * Commit each verified patch on a branch of Kintsugi's own, one commit per
   * fix. Requires a clean tree — otherwise its edits and the person's are
   * indistinguishable in the diff, which defeats the point of committing.
   */
  git?: boolean;
  /** Branch to work on in git mode. */
  branch?: string;
}

/**
 * The work graph as it stands right now — shape plus live per-node state.
 * Distinct from `UIGraph`: this one is the jobs, that one is the interface.
 */
export interface WorkGraphSnapshot {
  nodes: { id: string; job: string; dependsOn: string[] }[];
  layers: string[][];
  status: Record<string, 'pending' | 'running' | 'ok' | 'invalid' | 'failed' | 'skipped'>;
  ms: Record<string, number>;
}

export interface RunState {
  id: string;
  config: RunConfig;
  graph: UIGraph;
  /** Present once the first iteration has planned its graph. */
  work?: WorkGraphSnapshot;
  findings: Finding[];
  attempts: Attempt[];
  iteration: number;
  status: 'idle' | 'running' | 'converged' | 'exhausted' | 'failed';
  startedAt: string;
  endedAt?: string;
}
