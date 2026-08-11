import { resolve } from 'node:path';
import { Loop } from './loop.js';
import { loadConfig } from './config.js';
import { summarise, summaryLines, reportJson, exitCodeFor } from './report.js';
import type { RunConfig, LoopEvent } from './types.js';

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

const sourceRoot = resolve(args.get('source') ?? '.');
const loaded = loadConfig(sourceRoot, args.get('config'));

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
    'No checks configured. Write a kintsugi.config.json in the target repo, or\n' +
    'pass --checks <a,b,c>.\n\n' +
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
    '  --json               machine-readable final report on stdout\n' +
    '  --list-checks        print the checks that would run, then exit',
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
  git: args.has('git'),
  branch: args.get('branch'),
  quarantinedOk: args.has('quarantined-ok'),
};

const ICON = {
  observe: '◎', diagnose: '◆', repair: '✎', verify: '⟳', settle: '■',
} as const;

const say = (e: LoopEvent) =>
  console.log(`  ${ICON[e.phase]} [${e.iteration}] ${e.phase.padEnd(8)} ${e.message}`);

const loop = new Loop(config, say);
const state = await loop.run();

const summary = summarise(state, loop.actionableRemaining());

if (args.has('json')) {
  console.log(JSON.stringify(reportJson(summary, sourceRoot), null, 2));
} else {
  console.log(`\n  ${summaryLines(summary, sourceRoot).join('\n  ')}\n`);
}

process.exit(exitCodeFor(summary, config.quarantinedOk ?? false));
