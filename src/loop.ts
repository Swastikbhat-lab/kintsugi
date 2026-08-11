import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import type {
  RunConfig, RunState, Finding, Patch, Attempt, LoopEvent, Phase, CheckResult,
} from './types.js';
import { Ledger, ledgerPathFor } from './ledger.js';
import { proposePatches } from './propose.js';
import { runCheck } from './checks.js';
import { verifyPatch } from './verify.js';
import { buildImportGraph, scopeOf } from './imports.js';
import { byRisk, suppressFindings } from './risk.js';
import { applyEdits } from './patch.js';
import { createProvider, CRITIC_QUESTIONS, type Provider } from './provider.js';
import { Tracer } from './tracer.js';
import { execute, type WorkNode } from './graph.js';
import { inspect, useBranch, commitFile, logSince, head } from './git.js';

type Emit = (e: LoopEvent) => void;

/** Which loop phase each graph node reports as. */
const PHASE_OF = (id: string): Phase =>
  id.startsWith('observe') ? 'observe'
  : id === 'reduce' || id === 'diagnose' ? 'diagnose'
  : id === 'propose' ? 'repair'
  : 'verify';

/**
 * The loop, executed as a graph of agents.
 *
 * Each iteration deploys a small fleet: one observer agent per check (all
 * concurrent), a diagnoser, a proposer, three critic agents with fresh
 * contexts (concurrent), a majority gate, and a single serial verify tail.
 *
 *   observe(test)  observe(typecheck)  observe(lint)   ← independent, concurrent
 *            └─────────────┬──────────────┘
 *                       reduce                          ← plain code, no model
 *                          │
 *                       diagnose                        ← rank, consult the ledger
 *                          │
 *                       propose                         ← the only creative step
 *                          │
 *            ┌─────────────┼─────────────┐
 *         correct?    collateral?      valid?           ← fresh context each
 *            └─────────────┼─────────────┘
 *                        gate                           ← majority vote
 *                          │
 *                       verify                          ← apply, re-run checks, decide
 *
 * The tail is serial and must stay that way: two patches applied at once
 * destroy the verify step's ability to say which one caused what. That edge
 * is a real dependency, not a leftover from writing the steps in order.
 */
export class Loop {
  private state: RunState;
  private ledger: Ledger;
  private provider: Provider | null = null;
  private tracer: Tracer = new Tracer();
  /** HEAD before the run, so the final report can list only our commits. */
  private gitBase: string | null = null;
  /** Findings with no untried candidates, quarantined for THIS run only. */
  private quarantinedThisRun = new Set<string>();

  constructor(private config: RunConfig, private emit: Emit) {
    this.state = {
      id: randomUUID().slice(0, 8),
      config,
      findings: [],
      attempts: [],
      iteration: 0,
      status: 'idle',
      startedAt: new Date().toISOString(),
    };
    this.ledger = new Ledger(config.statePath ?? ledgerPathFor(config.sourceRoot));
  }

  get snapshot(): RunState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /** Findings still worth working on, given what the ledger has learned. */
  actionableRemaining(): Finding[] {
    return this.state.findings.filter((f) => !this.ledger.isExhausted(f));
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
    this.tracer = await Tracer.create();
    this.tracer.startRun({
      sourceRoot: this.config.sourceRoot,
      checks: this.config.checks.map((c) => c.name),
      budget: this.config.budget,
    });
    try {
      // Before touching anything: if we are going to commit, the tree has to
      // be clean first, or the person cannot tell our edits from their own.
      if (this.config.git) {
        const repo = await inspect(this.config.sourceRoot);
        if (!repo.isRepo) {
          throw new Error(`--git was set but ${this.config.sourceRoot} is not a git repository`);
        }
        if (!repo.clean) {
          throw new Error(
            `--git needs a clean tree; ${repo.dirty.length} path(s) have uncommitted changes ` +
            `(${repo.dirty.slice(0, 3).join(', ')}${repo.dirty.length > 3 ? ', …' : ''}). ` +
            `Commit or stash them first — otherwise Kintsugi's edits and yours end up in the same diff.`,
          );
        }
        this.gitBase = await head(this.config.sourceRoot);
        const branch = this.config.branch ?? 'kintsugi/fixes';
        await useBranch(this.config.sourceRoot, branch);
        this.say('settle', `Committing to branch ${branch} (was on ${repo.branch ?? 'detached HEAD'})`);
      }

      // Establish up front whether the model path works, rather than letting
      // a bad credential masquerade as the model having nothing to suggest.
      const provider = await createProvider(this.config);
      if (!provider) {
        this.say('settle', 'No model configured — running rules-only (every patch is still verified the same way)');
      } else if (provider.name === 'mock') {
        this.provider = provider;
        this.say('settle', 'Model proposer: mock — rules first, replayed proposals for what rules cannot reach');
      } else {
        const check = await (provider as any).preflight();
        if (check.ok) {
          this.provider = provider;
          this.say('settle', `Model proposer ${check.detail} — rules first, model for what rules cannot reach`);
        } else {
          this.say('settle', `Model proposer unavailable: ${check.detail}`);
          this.say('settle', 'Continuing rules-only. Findings with no mechanical rule will be reported, not fixed.');
        }
      }

      for (let i = 1; i <= this.config.maxIterations; i++) {
        this.state.iteration = i;
        const settled = await this.iterate();
        if (settled) break;
      }

      if (this.state.status === 'running') {
        this.state.status = 'exhausted';
        this.say('settle', `Iteration budget (${this.config.maxIterations}) reached`);
      }
    } catch (err) {
      this.state.status = 'failed';
      this.say('settle', `Run failed: ${(err as Error).message}`);
    } finally {
      // A final settle span mirroring the ledger's attempt records — one
      // entry per attempt with the same outcome vocabulary — so the trace
      // and the ledger tell the same story and are joinable on
      // fingerprint + outcome.
      try {
        this.tracer.span('settle', {
          status: this.state.status,
          iterations: this.state.iteration,
          attempts: this.state.attempts.map((a) => ({
            fingerprint: a.fingerprint,
            outcome: a.outcome,
            patch: { file: a.patch?.file, rationale: a.patch?.rationale },
            provider: a.provider,
            collateral: a.collateral,
            at: a.at,
          })),
        });
      } catch {
        // best effort
      }
      this.tracer.flush();
      if (this.config.git && this.gitBase) {
        const commits = await logSince(this.config.sourceRoot, this.gitBase);
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
    const { checks, sourceRoot, dryRun } = this.config;
    let settled = false;

    const nodes: WorkNode[] = [];

    // ---- fan out: one observer agent per check --------------------------
    for (const check of checks) {
      nodes.push({
        id: `observe:${check.name}`,
        job: `Run ${check.name} (${check.command})`,
        dependsOn: [],
        validate: (o: any) => !!o && typeof o === 'object' && 'findings' in o,
        run: async ({ emit }) => {
          const result = await runCheck(check, sourceRoot);
          this.tracer.span('observe', {
            check: check.name,
            durationMs: result.durationMs,
            findings: result.findings.length,
            crashed: result.crashed,
          });
          if (result.crashed) emit(`crashed (exit ${result.exitCode}) — a broken harness, not a defect; not healing`);
          else if (result.findings.length === 0) emit(`clean (${result.durationMs}ms)`);
          else emit(`${result.findings.length} finding(s) (${result.durationMs}ms)`);
          return result;
        },
      });
    }

    // ---- converge: plain code, no model ---------------------------------
    nodes.push({
      id: 'reduce',
      job: 'Merge check results into one deduplicated finding list',
      dependsOn: checks.map((c) => `observe:${c.name}`),
      validate: (o: any) => !!o && Array.isArray(o.findings) && o.baseline instanceof Set,
      run: async ({ deps, emit }) => {
        const findings: Finding[] = [];
        const seen = new Set<string>();
        for (const c of checks) {
          const result = deps[`observe:${c.name}`] as CheckResult;
          for (const f of result.findings) {
            if (seen.has(f.fingerprint)) continue;
            seen.add(f.fingerprint);
            findings.push(f);
          }
        }
        // Suppression (generated code, test-file style) filters the queue
        // before ranking; risk scoring then orders worst-first within each
        // severity band. Both engines apply the same arithmetic, so the
        // order they converge in is identical.
        const { kept, dropped } = suppressFindings(findings);
        if (dropped.length) {
          emit(`${dropped.length} finding(s) suppressed (generated, test-file style, or expected domain complexity)`);
        }
        kept.sort(byRisk);
        this.state.findings = kept;
        return { findings: kept, baseline: new Set(kept.map((f) => f.fingerprint)) };
      },
    });

    // ---- diagnose --------------------------------------------------------
    nodes.push({
      id: 'diagnose',
      job: 'Rank findings worst-first and pick one target',
      dependsOn: ['reduce'],
      validate: (o: any) => !!o && 'target' in o,
      run: async ({ deps, emit }) => {
        const { findings } = deps.reduce as { findings: Finding[] };
        const actionable = findings
          .filter(
            (f) =>
              !this.ledger.isExhausted(f) &&
              // Within one run, a finding with no untried candidates is
              // quarantined for this run — but only the ledger decides
              // whether that is permanent. Without this, a rules-only run
              // would re-target the same dead end every iteration.
              !this.quarantinedThisRun.has(f.fingerprint),
          )
          .sort(byRisk);

        const quarantined = findings.length - actionable.length;
        if (quarantined > 0) {
          emit(`${quarantined} finding(s) already quarantined — left for a human`);
        }
        if (actionable.length === 0) {
          emit('Nothing actionable left. Converged.');
          return { target: null };
        }
        emit(`Targeting ${actionable[0].check}: ${actionable[0].summary}`, actionable[0]);
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

        // Rules first: free, instant, and proven on these classes.
        let candidates = await proposePatches(target, sourceRoot);

        // The model is consulted only for what the rules could not reach.
        if (candidates.length === 0 && this.provider) {
          emit(`No rule covers ${target.code ?? target.check} — asking ${this.provider.name}`);
          try {
            candidates = await this.provider.propose(target, sourceRoot);
            emit(`${this.provider.name} proposed ${candidates.length} candidate(s)`);
            this.tracer.generation(
              'propose',
              (this.provider as any)?.lastUsage ?? null,
              { fingerprint: target.fingerprint, check: target.check, candidates: candidates.length },
            );
          } catch (err) {
            emit(`Model proposer failed: ${(err as Error).message}`);
          }
        }

        // Blast radius is decided now, from what the file is — a repair that
        // touches a module other files import changes code the loop is not
        // looking at, and the verify gate cannot catch that.
        const graph = buildImportGraph(sourceRoot);
        for (const p of candidates) {
          const { scope, importers } = scopeOf(graph, p.file);
          p.scope = scope;
          p.blastRadius = importers;
        }

        const viable = this.ledger.prioritise(target.fingerprint, candidates);
        return { candidates: viable, target };
      },
    });

    // ---- three critic agents, fresh context, in parallel -----------------
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

    // ---- verify: the serial tail -----------------------------------------
    nodes.push({
      id: 'verify',
      job: 'Apply, re-run the checks, and either commit or revert',
      dependsOn: ['reduce', 'propose', 'gate'],
      validate: (o: any) => typeof o?.settled === 'boolean',
      run: async ({ deps, emit }) => {
        const { candidates, target } = deps.propose as { candidates: Patch[]; target: Finding | null };
        const { passed } = deps.gate as { passed: boolean };
        const { baseline } = deps.reduce as { baseline: Set<string> };

        if (!target) return { settled: true, converged: true };

        if (!candidates.length) {
          emit('No untried patch available for this finding — quarantining for a human');
          this.quarantinedThisRun.add(target.fingerprint);
          this.record(target, null, 'unverifiable', []);
          return { settled: false };
        }
        if (!passed) {
          emit('Critic agents rejected the patch — recording and moving on');
          this.record(target, candidates[0], 'unverifiable', []);
          return { settled: false };
        }
        if (dryRun) return this.drySurvey(emit);

        const patch = candidates[0];

        // A shared file is out of scope for an automatic fix, however
        // cleanly it would clear the check. Editing it moves code the loop
        // is not looking at, which is a decision its owner makes — and the
        // verify gate cannot catch this, because the finding really does
        // clear. Escalating is the correct outcome, not a limitation.
        if (patch.scope === 'shared' && !this.config.allowShared) {
          emit(`ESCALATED — ${patch.rationale}`);
          emit(`Not applied: ${relative(sourceRoot, patch.file)} is imported by ${patch.blastRadius ?? '?'} ` +
            `module(s). Editing it reaches past the defect. Re-run with --allow-shared to override.`);
          this.record(target, patch, 'unverifiable', []);
          return { settled: false };
        }
        if (patch.scope === 'shared') {
          emit(`Shared-file change permitted by --allow-shared (${patch.blastRadius} importer(s))`);
        }

        emit(`Patch: ${patch.rationale}`);

        const restore = applyEdits([patch, ...(patch.also ?? [])], sourceRoot);
        let outcome: Attempt['outcome'];
        let collateral: string[] = [];
        let collateralDetail: string[] = [];

        try {
          const v = await verifyPatch(checks, sourceRoot, baseline, target.fingerprint);
          outcome = v.outcome;
          collateral = v.collateral.map((f) => f.fingerprint);
          collateralDetail = v.collateral.map((f) => `${f.check}: ${f.summary}`);
          // The span mirrors the ledger's attempt record: same fingerprint,
          // same patch identity, same outcome vocabulary — so a trace is
          // queryable by finding the way the ledger is.
          this.tracer.span('verify', {
            fingerprint: target.fingerprint,
            check: target.check,
            code: target.code ?? '',
            patch: {
              file: patch.file,
              find: patch.find,
              replace: patch.replace,
              rationale: patch.rationale,
            },
            outcome: v.outcome,
            collateral: collateralDetail,
            provider: !!this.provider,
            durationMs: v.runs.reduce((s, r) => s + r.durationMs, 0),
          });
        } catch (err) {
          // A failed verification proves nothing, so it cannot count as
          // success. Treat it as a failure and put the file back.
          emit(`Verification failed: ${(err as Error).message}`);
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
          if (this.config.git) {
            try {
              const sha = await commitFile(
                this.config.sourceRoot,
                patch.file,
                `Fix ${target.check}: ${target.summary.slice(0, 60)}`,
                `${target.summary}\n\n${patch.rationale}\n\nVerified by re-running the checks after ` +
                `the change: the finding cleared and no new finding appeared.`,
              );
              if (sha) emit(`  ${sha} committed to git`);
            } catch (err) {
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
    });

    const layerShape = report.layers.map((l) => l.length).join('→');
    this.say('observe', `Graph: ${report.layers.length} layers (${layerShape}) — ` +
      `${checks.length} observer agent(s) ran concurrently`);

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

  /** Dry-run survey: report every finding's mechanical answer, write nothing. */
  private async drySurvey(
    emit: (message: string, data?: unknown) => void,
  ): Promise<{ settled: boolean; converged: boolean }> {
    let withPatch = 0;
    let escalated = 0;
    let none = 0;
    for (const f of this.state.findings) {
      const cands = await proposePatches(f, this.config.sourceRoot);
      if (!cands.length) {
        none++;
        emit(`NO PATCH   ${f.check}: ${f.summary}`);
        continue;
      }
      const shared = cands[0].scope === 'shared' && !this.config.allowShared;
      if (shared) {
        escalated++;
        emit(`ESCALATE   ${f.check}: ${f.summary}`);
        emit(`           → ${relative(this.config.sourceRoot, cands[0].file)} — shared file, not applied automatically`);
      } else {
        withPatch++;
        emit(`WOULD PATCH ${f.check}: ${f.summary}`);
        emit(`           → ${relative(this.config.sourceRoot, cands[0].file)} — ${cands[0].rationale}`);
      }
    }
    emit(`Dry run: ${withPatch} patchable, ${escalated} escalated, ${none} with no mechanical answer. Nothing written.`);
    return { settled: true, converged: true };
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
        rationale: `no candidate patch for ${finding.check}: ${finding.summary}`,
        scope: 'local',
      },
      outcome,
      at: new Date().toISOString(),
      collateral,
      provider: !!this.provider,
    };
    this.ledger.record(attempt);
    this.state.attempts.push(attempt);
  }
}


