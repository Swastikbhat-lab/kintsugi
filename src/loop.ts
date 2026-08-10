import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type {
  RunConfig, RunState, Finding, Patch, Attempt, LoopEvent, Phase,
} from './types.js';
import { Ledger, ledgerPathFor } from './heal/ledger.js';
import { proposePatches } from './heal/propose.js';
import { Observer } from './observe.js';
import { execute, type WorkNode } from './graph/workflow.js';
import { inspect, useBranch, commitFile, logSince, head } from './git.js';
import { ClaudeProvider, CRITIC_QUESTIONS, type Provider } from './agent/provider.js';

type Emit = (e: LoopEvent) => void;

/** Which loop phase each graph node reports as. */
const PHASE_OF = (id: string): Phase =>
  id.startsWith('observe') ? 'observe'
  : id === 'reduce' || id === 'diagnose' ? 'diagnose'
  : id === 'propose' ? 'repair'
  : 'verify';

/**
 * The loop, executed as a graph.
 *
 * Each iteration builds a diamond: routes are observed in parallel, converge
 * into one ranked finding list, one patch is proposed, that patch is checked
 * from several angles in parallel, and then a single serial tail applies and
 * verifies it.
 *
 *   observe(/)  observe(/a)  observe(/b)     ← independent, so concurrent
 *          └─────────┬─────────┘
 *                 reduce                      ← plain code, no model
 *                    │
 *                 diagnose                    ← rank, consult the ledger
 *                    │
 *                 propose                     ← the only creative step
 *                    │
 *       ┌────────────┼────────────┐
 *    correct?    collateral?    valid?         ← fresh context each
 *       └────────────┼────────────┘
 *                  gate                        ← majority
 *                    │
 *                 verify                       ← apply, re-measure, decide
 *
 * The tail is serial and must stay that way: two patches applied at once
 * destroy the verify step's ability to say which one caused what.
 */
export class Loop {
  private state: RunState;
  private ledger: Ledger;
  private observer: Observer;
  private provider: Provider | null = null;
  /** HEAD before the run, so the final report can list only our commits. */
  private gitBase: string | null = null;

  constructor(config: RunConfig, private emit: Emit) {
    this.state = {
      id: randomUUID().slice(0, 8),
      config,
      graph: { nodes: {}, edges: [] },
      findings: [],
      attempts: [],
      iteration: 0,
      status: 'idle',
      startedAt: new Date().toISOString(),
    };
    this.ledger = new Ledger(ledgerPathFor(config.sourceRoot));
    this.observer = new Observer(config);
  }

  get snapshot(): RunState {
    return JSON.parse(JSON.stringify(this.state));
  }

  private say(phase: Phase, message: string, data?: unknown) {
    this.emit({
      runId: this.state.id,
      iteration: this.state.iteration,
      phase,
      at: new Date().toISOString(),
      message,
      data,
    });
  }

  async run(): Promise<RunState> {
    this.state.status = 'running';
    try {
      // Before touching anything: if we are going to commit, the tree has to
      // be clean first, or the person cannot tell our edits from their own.
      if (this.state.config.git) {
        const repo = await inspect(this.state.config.sourceRoot);
        if (!repo.isRepo) {
          throw new Error(`--git was set but ${this.state.config.sourceRoot} is not a git repository`);
        }
        if (!repo.clean) {
          throw new Error(
            `--git needs a clean tree; ${repo.dirty.length} path(s) have uncommitted changes ` +
            `(${repo.dirty.slice(0, 3).join(', ')}${repo.dirty.length > 3 ? ', …' : ''}). ` +
            `Commit or stash them first — otherwise Kintsugi's edits and yours end up in the same diff.`,
          );
        }
        this.gitBase = await head(this.state.config.sourceRoot);
        const branch = this.state.config.branch ?? `kintsugi/ui-fixes`;
        await useBranch(this.state.config.sourceRoot, branch);
        this.say('settle', `Committing to branch ${branch} (was on ${repo.branch ?? 'detached HEAD'})`);
      }

      await this.observer.open();
      this.say('settle', this.observer.attached
        ? 'Attached to your signed-in browser — pages behind a login are reachable'
        : 'Launched a fresh browser — only pages that need no login are reachable (use --attach for the rest)');

      this.provider = await ClaudeProvider.create();
      this.say('settle', this.provider
        ? `Model proposer available (${this.provider.name}) — rules first, model for what rules cannot reach`
        : 'No model credentials found — running rules-only (every patch still verified the same way)');

      for (let i = 1; i <= this.state.config.maxIterations; i++) {
        this.state.iteration = i;
        const settled = await this.iterate();
        if (settled) break;
      }

      if (this.state.status === 'running') {
        this.state.status = 'exhausted';
        this.say('settle', `Iteration budget (${this.state.config.maxIterations}) reached`);
      }
    } catch (err) {
      this.state.status = 'failed';
      this.say('settle', `Run failed: ${(err as Error).message}`);
    } finally {
      await this.observer.close();

      if (this.state.config.git && this.gitBase) {
        const commits = await logSince(this.state.config.sourceRoot, this.gitBase);
        this.say('settle', commits.length
          ? `${commits.length} commit(s) on this branch — review with: git log -p ${this.gitBase.slice(0, 7)}..HEAD`
          : 'No commits — nothing was verified as safe to apply');
        for (const c of commits) this.say('settle', `  ${c}`);
      }

      this.state.endedAt = new Date().toISOString();
    }

    return this.state;
  }

  /** Build and run one iteration's graph. Returns true when the loop should stop. */
  private async iterate(): Promise<boolean> {
    const { routes, sourceRoot, dryRun } = this.state.config;
    let settled = false;

    const nodes: WorkNode[] = [];

    // ---- fan out: one node per route ------------------------------------
    for (const route of routes) {
      nodes.push({
        id: `observe:${route}`,
        job: `Measure ${route} against every detector`,
        dependsOn: [],
        validate: (o: any) => !!o && typeof o === 'object' && Array.isArray(o.findings),
        run: async ({ emit }) => {
          const part = await this.observer.sweepRoute(route);
          emit(`${route}: ${part.findings.length} finding(s)`);
          return part;
        },
      });
    }

    // ---- converge: plain code, no model ---------------------------------
    nodes.push({
      id: 'reduce',
      job: 'Merge route observations into one graph and one finding list',
      dependsOn: routes.map((r) => `observe:${r}`),
      validate: (o: any) => !!o && Array.isArray(o.findings),
      run: async ({ deps }) => {
        const graph = { nodes: {} as any, edges: [] as any[] };
        const findings: Finding[] = [];
        const seen = new Set<string>();
        for (const route of routes) {
          const part = deps[`observe:${route}`] as { graph: any; findings: Finding[] };
          Object.assign(graph.nodes, part.graph.nodes);
          graph.edges.push(...part.graph.edges);
          for (const f of part.findings) {
            if (seen.has(f.fingerprint)) continue;
            seen.add(f.fingerprint);
            findings.push(f);
          }
        }
        this.state.graph = graph;
        this.state.findings = findings;
        return { graph, findings };
      },
    });

    // ---- diagnose --------------------------------------------------------
    nodes.push({
      id: 'diagnose',
      job: 'Rank findings worst-first and pick one target',
      dependsOn: ['reduce'],
      validate: (o: any) => !!o && typeof o === 'object' && 'target' in o,
      run: async ({ deps, emit }) => {
        const { findings } = deps.reduce as { findings: Finding[] };
        const actionable = findings
          .filter((f) => !this.ledger.isExhausted(f))
          .sort(bySeverityThenRatio);

        const quarantined = findings.length - actionable.length;
        if (quarantined > 0) {
          emit(`${quarantined} finding(s) quarantined — repeatedly unfixable, left for a human`);
        }
        if (actionable.length === 0) {
          emit('Nothing actionable left. Converged.');
          return { target: null };
        }
        emit(`Targeting ${actionable[0].detector}: ${actionable[0].summary}`, actionable[0]);
        return { target: actionable[0] };
      },
    });

    // ---- propose ---------------------------------------------------------
    nodes.push({
      id: 'propose',
      job: 'Produce candidate patches for the target finding',
      dependsOn: ['diagnose'],
      validate: (o: any) => Array.isArray(o?.candidates),
      run: async ({ deps, emit }) => {
        const target = (deps.diagnose as any).target as Finding | null;
        if (!target) return { candidates: [], target: null };

        // Rules first: free, instant, and already proven on these classes.
        let candidates = await proposePatches(target, sourceRoot);

        // The model is consulted only for what the rules could not reach.
        if (candidates.length === 0 && this.provider) {
          emit(`No rule covers ${target.detector} — asking ${this.provider.name}`);
          try {
            candidates = await this.provider.propose(target, sourceRoot);
            emit(`${this.provider.name} proposed ${candidates.length} candidate(s)`);
          } catch (err) {
            emit(`Model proposer failed: ${(err as Error).message}`);
          }
        }

        const viable = this.ledger.prioritise(target.fingerprint, candidates);
        return { candidates: viable, target };
      },
    });

    // ---- three checkers, fresh context, in parallel ----------------------
    CRITIC_QUESTIONS.forEach((question, idx) => {
      nodes.push({
        id: `critic:${idx}`,
        job: question,
        dependsOn: ['propose'],
        validate: (o: any) => !!o && (o.verdict === 'keep' || o.verdict === 'drop'),
        run: async ({ deps, emit }) => {
          const { candidates, target } = deps.propose as { candidates: Patch[]; target: Finding | null };
          // Nothing to judge, or no judge available. Abstaining as "keep" is
          // safe because the deterministic verify gate still runs afterwards.
          if (!candidates.length || !target || !this.provider?.critique) {
            return { verdict: 'keep', reason: 'not consulted' };
          }
          const out = await this.provider.critique(candidates[0], target, question);
          if (!out) return { verdict: 'keep', reason: 'no verdict returned' };
          if (out.verdict === 'drop') emit(`drop — ${out.reason}`);
          return out;
        },
      });
    });

    // ---- gate ------------------------------------------------------------
    nodes.push({
      id: 'gate',
      job: 'Majority vote across the three checks',
      dependsOn: CRITIC_QUESTIONS.map((_, i) => `critic:${i}`),
      validate: (o: any) => typeof o?.passed === 'boolean',
      run: async ({ deps, emit }) => {
        const verdicts = CRITIC_QUESTIONS.map((_, i) => (deps[`critic:${i}`] as any).verdict);
        const drops = verdicts.filter((v) => v === 'drop').length;
        const passed = drops < Math.ceil(verdicts.length / 2);
        if (drops > 0) emit(`${drops}/${verdicts.length} checks voted drop — ${passed ? 'proceeding' : 'rejecting'}`);
        return { passed };
      },
    });

    // ---- verify: serial tail --------------------------------------------
    nodes.push({
      id: 'verify',
      job: 'Apply, re-measure, and either commit or revert',
      dependsOn: ['propose', 'gate'],
      validate: (o: any) => typeof o?.settled === 'boolean',
      run: async ({ deps, emit }) => {
        const { candidates, target } = deps.propose as { candidates: Patch[]; target: Finding | null };
        const { passed } = deps.gate as { passed: boolean };

        if (!target) return { settled: true, converged: true };

        if (!candidates.length) {
          emit('No untried patch available for this finding — quarantining');
          this.record(target, null, 'unverifiable', []);
          return { settled: false };
        }
        if (!passed) {
          this.record(target, candidates[0], 'regressed', []);
          return { settled: false };
        }
        if (dryRun) {
          // Survey every finding rather than stopping at the first. On a real
          // codebase the useful question is not "can it fix one thing" but
          // "which of these does it have an answer for at all".
          let withPatch = 0;
          for (const f of this.state.findings) {
            const cands = await proposePatches(f, sourceRoot);
            if (cands.length) {
              const wide = cands[0].scope === 'token' || cands[0].scope === 'global';
              const blocked = wide && !this.state.config.allowTokens;
              if (!blocked) withPatch++;
              emit(`${blocked ? 'ESCALATE   ' : 'WOULD PATCH'}  ${f.detector}: ${f.summary}`);
              emit(`             → ${relative(sourceRoot, cands[0].file)} — ${cands[0].rationale}`);
            } else {
              emit(`NO PATCH     ${f.detector}: ${f.summary}`);
            }
          }
          emit(`Dry run: ${withPatch}/${this.state.findings.length} finding(s) have a mechanical patch. Nothing written.`);
          return { settled: true, converged: true };
        }

        const patch = candidates[0];

        // A shared design token is out of scope for an automatic fix, however
        // cleanly it would clear the measurement. Retinting one changes the
        // product everywhere it is used, which is a decision its owner makes
        // — and the verify gate cannot catch this, because the finding really
        // does clear. Escalating is the correct outcome, not a limitation.
        const appWide = patch.scope === 'token' || patch.scope === 'global';
        if (appWide && !this.state.config.allowTokens) {
          emit(`ESCALATED — ${patch.rationale}`);
          emit(`Not applied: this reaches past the defect into the rest of the product, ` +
            `which is a decision rather than a fix. Re-run with --allow-tokens to override.`);
          this.record(target, patch, 'unverifiable', []);
          return { settled: false };
        }
        if (appWide) {
          emit(`App-wide change permitted by --allow-tokens${
            patch.blastRadius !== undefined ? ` — ${patch.blastRadius} use site(s) affected` : ''}`);
        }

        emit(`Patch: ${patch.rationale}`);

        const restore = this.apply(patch);
        let outcome: Attempt['outcome'];
        let collateral: string[] = [];
        let collateralDetail: string[] = [];

        try {
          // The patch has to reach the running app before re-measuring. A dev
          // server needs a beat to recompile, and observing through that
          // window reads the old CSS as "ineffective" or a half-applied page
          // as "regressed" — both of which are the measurement's fault, not
          // the patch's.
          await new Promise((r) => setTimeout(r, 600));

          const after = await this.observer.resweep(target.nodeId);
          const cleared = !after.some((f) => f.fingerprint === target.fingerprint);
          const before = new Set(this.state.findings.map((f) => f.fingerprint));
          const fresh = after.filter((f) => !before.has(f.fingerprint));
          collateral = fresh.map((f) => f.fingerprint);
          collateralDetail = fresh.map((f) => `${f.detector}: ${f.summary}`);

          if (cleared && collateral.length === 0) outcome = 'committed';
          else if (cleared) outcome = 'regressed';
          else outcome = 'ineffective';
        } catch (err) {
          // A failed re-observation proves nothing, so it cannot count as
          // success. Treat it as a failure and put the file back.
          emit(`Re-observation failed: ${(err as Error).message}`);
          outcome = 'unverifiable';
        }

        if (outcome !== 'committed') {
          restore();
          emit(`${outcome} — reverted`, { collateral });
          for (const c of collateralDetail) emit(`  caused: ${c}`);
        } else {
          emit('committed — finding cleared with no collateral');

          // One commit per verified fix, so each can be read, kept, or
          // dropped on its own merits rather than as an all-or-nothing blob.
          if (this.state.config.git) {
            try {
              const sha = await commitFile(
                this.state.config.sourceRoot,
                patch.file,
                `Fix ${target.detector} on ${relative(sourceRoot, patch.file)}`,
                `${target.summary}\n\n${patch.rationale}\n\n` +
                `Verified by re-measuring the page after the change: the finding cleared ` +
                `and no new finding appeared.`,
              );
              if (sha) emit(`  ${sha} committed to git`);
            } catch (err) {
              // A failed commit does not invalidate the fix — the edit is
              // still on disk and still verified. Say so and carry on.
              emit(`  git commit failed (the fix is still applied): ${(err as Error).message}`);
            }
          }
        }

        this.record(target, patch, outcome, collateral);
        return { settled: false };
      },
    });

    // ---- run the graph ---------------------------------------------------
    const report = await execute(nodes, {
      emit: (nodeId, message, data) => this.say(PHASE_OF(nodeId), message, data),
      onPlan: (p) => {
        this.state.work = {
          nodes: p.nodes,
          layers: p.layers,
          status: Object.fromEntries(p.nodes.map((n) => [n.id, 'pending' as const])),
          ms: {},
        };
      },
      onNodeStatus: (id, status, ms) => {
        if (!this.state.work) return;
        this.state.work.status[id] = status;
        if (ms !== undefined) this.state.work.ms[id] = ms;
      },
    });

    const layerShape = report.layers.map((l) => l.length).join('→');
    this.say('observe', `Graph: ${report.layers.length} layers (${layerShape}), ${routes.length} route(s) observed concurrently`);

    for (const r of Object.values(report.results)) {
      if (r.status === 'invalid') {
        this.say('repair', `Node ${r.id} returned a result that did not match its contract after ${r.attempts} attempt(s) — discarded`);
      } else if (r.status === 'failed') {
        this.say('repair', `Node ${r.id} failed: ${r.error}`);
      }
    }

    const verify = report.results.verify;
    if (verify?.status === 'ok') {
      const out = verify.output as { settled: boolean; converged?: boolean };
      if (out.converged) {
        this.state.status = 'converged';
        this.say('settle', 'Converged.');
        settled = true;
      }
    } else if (verify?.status === 'skipped') {
      // The tail could not run because something upstream failed. Stopping is
      // correct: continuing would loop on a graph that cannot reach a verdict.
      this.state.status = 'failed';
      this.say('settle', `Iteration could not complete: ${verify.error}`);
      settled = true;
    }

    return settled;
  }

  /**
   * Write a patch and hand back the undo. Refuses to touch anything outside
   * the configured source root — a healer must not be able to wander into
   * the rest of the disk, and a model-proposed path is untrusted input.
   */
  private apply(patch: Patch): () => void {
    const root = resolve(this.state.config.sourceRoot);
    const file = resolve(patch.file);
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Patch targets ${file}, outside source root ${root}`);
    }

    const original = readFileSync(file, 'utf8');
    if (!original.includes(patch.find)) {
      throw new Error(`Anchor not found in ${rel} — refusing to guess`);
    }

    // Match the file's own line endings. Healers are written with "\n", so on
    // a CRLF file every inserted line would arrive bare — leaving the file
    // mixed, and putting line-ending noise in someone's diff on top of the
    // two lines they actually wanted.
    const crlf = (original.match(/\r\n/g) ?? []).length;
    const lf = (original.match(/(?<!\r)\n/g) ?? []).length;
    const replacement = crlf > lf
      ? patch.replace.replace(/\r?\n/g, '\r\n')
      : patch.replace;

    // Replace the first occurrence only. A patch that matches in several
    // places is ambiguous, and applying it everywhere is how one contrast
    // fix quietly restyles half an app.
    writeFileSync(file, original.replace(patch.find, replacement));
    return () => writeFileSync(file, original);
  }

  private record(
    finding: Finding,
    patch: Patch | null,
    outcome: Attempt['outcome'],
    collateral: string[],
  ) {
    const attempt: Attempt = {
      fingerprint: finding.fingerprint,
      patch: patch ?? {
        id: 'none', file: '', find: '', replace: '',
        rationale: 'no candidate patch',
      },
      outcome,
      at: new Date().toISOString(),
      collateral,
    };
    this.ledger.record(attempt);
    this.state.attempts.push(attempt);
  }
}

const RANK = { blocker: 0, major: 1, minor: 2 } as const;

/** Worst first, and within a severity the worst contrast ratio first. */
function bySeverityThenRatio(a: Finding, b: Finding): number {
  const s = RANK[a.severity] - RANK[b.severity];
  if (s !== 0) return s;
  const ar = (a.evidence.ratio as number) ?? Infinity;
  const br = (b.evidence.ratio as number) ?? Infinity;
  return ar - br;
}
