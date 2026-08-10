import { resolve } from 'node:path';
import { Loop } from './loop.js';
import type { RunConfig } from './types.js';

/**
 * Headless entry point, for CI and for driving a run without the dashboard.
 *
 *   npm run cli -- --target http://localhost:5173 --source ./app --routes /,/settings
 */

/**
 * Flags may or may not take a value. Advancing two at a time assumes they
 * always do, which makes a bare `--dry` silently swallow the flag after it —
 * so `--dry --allow-tokens` parsed as `dry="--allow-tokens"` and the second
 * flag simply vanished.
 */
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

const target = args.get('target');
const source = args.get('source');

if (!target || !source) {
  console.error(
    'Usage: npm run cli -- --target <url> --source <repo> [options]\n' +
    '\n' +
    '  --routes /,/settings   routes to walk (default /)\n' +
    '  --max 8                iteration ceiling\n' +
    '  --dry                  compute patches, write nothing\n' +
    '  --allow-tokens         permit shared design-token retints (off by default)\n' +
    '  --git                  commit each verified fix on its own branch;\n' +
    '                         requires a clean tree so its edits stay yours to review\n' +
    '  --branch <name>        branch to use with --git (default kintsugi/ui-fixes)\n' +
    '  --attach http://localhost:9222\n' +
    '                         use a browser you already signed into, instead of\n' +
    '                         launching a fresh one that can only see public pages',
  );
  process.exit(2);
}

const config: RunConfig = {
  target,
  sourceRoot: resolve(source),
  routes: (args.get('routes') ?? '/').split(',').map((r) => r.trim()).filter(Boolean),
  maxIterations: Number(args.get('max') ?? 8),
  dryRun: args.has('dry'),
  allowTokens: args.has('allow-tokens'),
  attach: args.get('attach'),
  git: args.has('git'),
  branch: args.get('branch'),
};

const ICON = {
  observe: '◎', diagnose: '◆', repair: '✎', verify: '⟳', settle: '■',
} as const;

const loop = new Loop(config, (e) => {
  console.log(`  ${ICON[e.phase]} [${e.iteration}] ${e.phase.padEnd(8)} ${e.message}`);
});

const state = await loop.run();

const committed = state.attempts.filter((a) => a.outcome === 'committed');
const rejected = state.attempts.filter((a) => a.outcome !== 'committed');

console.log(`\n  ${state.status.toUpperCase()} after ${state.iteration} iteration(s)`);
console.log(`  ${committed.length} patch(es) committed, ${rejected.length} rejected and reverted`);
console.log(`  ${state.findings.length} finding(s) outstanding\n`);

for (const a of committed) {
  console.log(`  ✓ ${a.patch.rationale}`);
}
for (const f of state.findings) {
  console.log(`  · [${f.severity}] ${f.summary}`);
}

// Non-zero when defects remain, so this can gate a pipeline.
process.exit(state.findings.length > 0 ? 1 : 0);
