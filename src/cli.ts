import { resolve } from 'node:path';
import { watch as fsWatch } from 'node:fs';
import { auditTrace, createAuditClient, printAudit } from './audit.js';
import { Loop } from './loop.js';
import { loadConfig } from './config.js';
import { summarise, summaryLines, reportJson, exitCodeFor } from './report.js';
import { costUsd } from './tracer.js';
import { WatchSession, snapshotTree, changedPaths } from './watch.js';
import { pushBranch } from './git.js';
import type { RunConfig, LoopEvent, RunState } from './types.js';

/**
 * Headless entry point, for CI and for driving a run without a dashboard.
 *
 *   npm run cli -- --source ./fixture --dry
 *   npm run cli -- --source ./fixture --llm-mock fixture/proposals/tax-rate.json
 */

/** Flags may or may not take a value. */
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token?.startsWith('--')) continue;
  const key = token.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    i++;
  } else {
    args.set(key, 'true');
  }
}

// Audit mode: no loop runs, no source needed — read a finished run's trace
// from Langfuse and print the per-finding cost table.
if (args.has('trace')) {
  const client = await createAuditClient();
  if (!client) {
    console.error('kintsugi: auditing needs LANGFUSE_PUBLIC_KEY/SECRET_KEY and the ' +
      '@langfuse/client package (npm install @langfuse/client)');
    process.exit(2);
  }
  console.log(printAudit(await auditTrace(client, args.get('trace')!), costUsd));
  process.exit(0);
}

const sourceRoot = resolve(args.get('source') ?? '.');
// An explicit --config is resolved against where the command was run; the
// default (no flag) stays <source>/kintsugi.config.json.
const configPath = args.get('config') ? resolve(args.get('config')!) : undefined;
const loaded = await loadConfig(sourceRoot, configPath);

let checks = loaded.checks;
if (args.has('checks')) {
  const names = args.get('checks')!.split(',').map((s) => s.trim()).filter(Boolean);
  checks = checks.filter((c) => names.includes(c.name));
}

if (args.has('list-checks')) {
  for (const c of checks) {
    console.log(`${c.name}\t${c.command}\t(${c.parser})`);
  }
  process.exit(0);
}

if (checks.length === 0) {
  console.error(
    'No checks discovered. Without a kintsugi.config.json the engine detects the\n' +
    'repo\'s toolchain: npm (typecheck + test scripts), Python (pytest + ruff,\n' +
    'venv-aware), Go (go test + go vet). Nothing matched — write a\n' +
    'kintsugi.config.json in the target repo, or pass --checks <a,b,c>.\n\n' +
    'Usage: npm run cli -- --source <repo> [options]\n' +
    '\n' +
    '  --config <path>      config file (default <source>/kintsugi.config.json)\n' +
    '  --checks a,b,c       run only these checks\n' +
    '  --budget <n>         repair attempts per finding (default 2)\n' +
    '  --max <n>            iteration ceiling (default 12)\n' +
    '  --dry                survey every finding, write nothing\n' +
    '  --allow-shared       permit patches on files other modules import\n' +
    '                       (escalated by default — that is a decision, not a fix)\n' +
    '  --llm-mock <path>    replay canned proposals (keyless demo/tests)\n' +
    '  --state <path>       ledger path (default ~/.kintsugi/ledgers/<hash>.json)\n' +
    '  --quarantined-ok     exit 0 when only quarantined findings remain\n' +
    '  --git                commit each verified fix on its own branch; requires\n' +
    '                       a clean tree so its edits stay yours to review\n' +
    '  --branch <name>      branch to use with --git (default kintsugi/fixes)\n' +
    '  --push               after the run, push the fix branch to origin\n' +
    '                       (the pusher role; requires --git and a remote)\n' +
    '  --json               machine-readable final report on stdout\n' +
    '  --list-checks        print the checks that would run, then exit\n' +
    '  --watch              keep repairing as the repo drifts (Ctrl+C to stop)\n' +
    '  --interval <secs>    with --watch: also re-check every N seconds\n' +
    '  --trace <id>         audit a finished run: read its Langfuse trace and\n' +
    '                       print the per-finding cost table (needs LANGFUSE keys)\n' +
    '  --audit-log <path>   append one NDJSON line per repair attempt plus a\n' +
    '                       run summary (fingerprint, outcome, cost) — no service',
  );
  process.exit(2);
}

const config: RunConfig = {
  sourceRoot,
  checks,
  budget: Number(args.get('budget') ?? loaded.budget),
  maxIterations: Number(args.get('max') ?? loaded.maxIterations),
  dryRun: args.has('dry'),
  allowShared: args.has('allow-shared'),
  llmMock: args.get('llm-mock'),
  statePath: args.get('state'),
  auditLog: args.get('audit-log'),
  git: args.has('git'),
  branch: args.get('branch'),
  quarantinedOk: args.has('quarantined-ok'),
  push: args.has('push') && args.has('git'),
};

const ICON = {
  observe: '◎', diagnose: '◆', repair: '✎', verify: '⟳', settle: '■',
} as const;

// Human-facing progress goes to stderr so stdout stays clean for the
// machine: with --json, stdout carries exactly the report and nothing else
// (the GitHub Action pipes it straight into a file).
const say = (e: LoopEvent) =>
  console.error(`  ${ICON[e.phase]} [${e.iteration}] ${e.phase.padEnd(8)} ${e.message}`);

/** One pass of the loop plus its report. Returns the exit code and the state. */
async function runOnce(): Promise<{ code: number; state: RunState }> {
  const loop = new Loop(config, say);
  const state = await loop.run();

  // The pusher role: after the loop verified and committed the repairs,
  // push the branch so the owner can open the fix PR. Only when --git and
  // --push were both given, and only after the loop finished (converged or
  // exhausted — either way the branch holds exactly what was proven).
  if (config.push) {
    const branch = config.branch ?? 'kintsugi/fixes';
    const result = await pushBranch(sourceRoot, branch);
    if (result === 'pushed') {
      console.error(`  ⌁ pusher: ${branch} pushed to origin`);
    } else {
      console.error(`  ⌁ pusher: no remote for ${branch} — committed locally, not pushed`);
    }
  }
  const summary = summarise(state, loop.actionableRemaining());
  if (args.has('json')) {
    console.log(JSON.stringify(reportJson(summary, sourceRoot), null, 2));
  } else {
    console.log(`\n  ${summaryLines(summary, sourceRoot).join('\n  ')}\n`);
  }
  return { code: exitCodeFor(summary, config.quarantinedOk ?? false), state };
}

if (!args.has('watch')) {
  process.exit((await runOnce()).code);
}

// ---- watch mode: keep the repo repaired as it drifts ---------------------
const debounceMs = 2000;
const intervalSecs = Number(args.get('interval') ?? 0);
const intervalMs = Number.isFinite(intervalSecs) && intervalSecs > 0 ? intervalSecs * 1000 : 0;

const session = new WatchSession({
  debounceMs,
  intervalMs,
  onRun: async () => {
    const { state } = await runOnce();
    // The files this pass wrote are the loop's own echo — the session drops
    // their events so a repair never re-triggers itself.
    return state.attempts.map((a) => a.patch.file);
  },
  log: (msg) => console.error(`  ⌁ ${msg}`),
});

console.error(`  Watching ${sourceRoot} — Ctrl+C to stop. A change is checked ${debounceMs / 1000}s after it settles.`);

let polling = false;
const stop = () => {
  session.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const startPolling = () => {
  if (polling) return;
  polling = true;
  let prev = snapshotTree(sourceRoot);
  const cadence = Math.max(intervalMs || 5000, debounceMs);
  console.error('  recursive file watching unavailable — polling for changes instead');
  setInterval(() => {
    const next = snapshotTree(sourceRoot);
    const changed = changedPaths(prev, next);
    if (changed.length) {
      prev = next;
      for (const p of changed) session.onChange(p);
    }
  }, cadence);
};

try {
  const watcher = fsWatch(sourceRoot, { recursive: true }, (event, filename) => {
    session.onChange(filename?.toString() ?? null);
  });
  watcher.on('error', (err) => {
    console.error(`  file watcher failed: ${err.message}`);
    try { watcher.close(); } catch { /* already closed */ }
    startPolling();
  });
} catch (err) {
  console.error(`  file watcher failed: ${(err as Error).message}`);
  startPolling();
}

session.start();
