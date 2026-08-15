import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);

/** The complete fleet. The list is the test's own contract: the count is
 * ten roles, not the original four — the pusher included. */
const FLEET = [
  'kintsugi-checker.md',
  'kintsugi-critic.md',
  'kintsugi-healer.md',
  'kintsugi-observer.md',
  'kintsugi-overseer.md',
  'kintsugi-planner.md',
  'kintsugi-pusher.md',
  'kintsugi-researcher.md',
  'kintsugi-tester.md',
  'kintsugi-verifier.md',
].sort();

test('--install-agents ships all ten roles from a fresh skill copy', async () => {
  const skill = resolve(import.meta.dirname, '../skills/kintsugi');
  const sourceFleet = join(skill, 'agents');

  // The test's own premise: the bundled fleet must be complete.
  const source = readdirSync(sourceFleet)
    .filter((f) => f.startsWith('kintsugi-') && f.endsWith('.md'))
    .sort();
  assert.deepEqual(source, FLEET, `skills/kintsugi/agents must ship all ten roles, got: ${source.join(', ')}`);

  // A fresh skill-only copy — the standalone install layout. The agents
  // dir sits at the skill root, next to scripts/, which is exactly where
  // --install-agents must look (it used to check scripts/agents and fall
  // through to a bootstrapped engine clone, shipping only four roles).
  const copy = mkdtempSync(join(tmpdir(), 'kintsugi-skill-'));
  cpSync(skill, copy, { recursive: true });

  // Fake HOME: an empty agents dir with a sentinel non-kintsugi agent (the
  // real-world case — the user's own fleet must survive), and crucially NO
  // ~/.kintsugi/engine. If the skill-root resolution regresses, find_engine
  // would try to bootstrap a clone over the network and the test fails
  // instead of silently passing.
  const home = mkdtempSync(join(tmpdir(), 'kintsugi-home-'));
  const dest = join(home, '.claude', 'agents');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'engineering-code-reviewer.md'), 'sentinel — not ours to touch');

  const script = join(copy, 'scripts', 'run-loop.sh');
  const { stderr } = await exec('bash', [script, '--install-agents'], {
    cwd: join(copy, 'scripts'),
    env: { ...process.env, HOME: home },
    timeout: 30_000,
  });

  assert.match(stderr, /installed the fleet/, 'the fleet message should print');

  // Exactly the ten roles land, nothing else, and nothing else is touched.
  const landed = readdirSync(dest)
    .filter((f) => f.startsWith('kintsugi-') && f.endsWith('.md'))
    .sort();
  assert.deepEqual(landed, FLEET, `expected all ${FLEET.length} roles in ~/.claude/agents, got: ${landed.join(', ')}`);
  assert.equal(
    readFileSync(join(dest, 'engineering-code-reviewer.md'), 'utf8'),
    'sentinel — not ours to touch',
    'non-kintsugi agents must be left alone',
  );

  // Byte-identical to the source fleet — no stale or truncated profiles.
  for (const f of landed) {
    assert.equal(
      readFileSync(join(dest, f), 'utf8'),
      readFileSync(join(sourceFleet, f), 'utf8'),
      `${f} should be byte-identical to the skill fleet`,
    );
  }
  assert.ok(existsSync(script), 'run-loop.sh should exist in the fresh copy');
});
