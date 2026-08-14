import { mkdir, cp, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);

/** The kintsugi fixture — a deliberately broken package the engine repairs. */
export const FIXTURE = fileURLToPath(new URL('../../fixture/', import.meta.url));

export const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {} });

/** A recording stub of the octokit surface the app touches. */
export function stubOctokit(options = {}) {
  const calls = [];
  const octokit = {
    auth: async () => ({ token: options.token ?? 'fake-token' }),
    issues: {
      listComments: async (p) => { calls.push(['listComments', p]); return { data: options.comments ?? [] }; },
      createComment: async (p) => { calls.push(['createComment', p]); return { data: { id: 1 } }; },
      updateComment: async (p) => { calls.push(['updateComment', p]); return { data: {} }; },
    },
    pulls: {
      list: async (p) => { calls.push(['pulls.list', p]); return { data: options.openPulls ?? [] }; },
      get: async (p) => { calls.push(['pulls.get', p]); return { data: { base: { ref: options.base ?? 'main' } } }; },
      create: async (p) => { calls.push(['pulls.create', p]); return { data: { number: 99 } }; },
    },
  };
  return { octokit, calls };
}

export function fakeContext({ payload, octokit, log = silentLog() } = {}) {
  return { payload, octokit, log };
}

export function pullRequestPayload({ number = 12, draft = false } = {}) {
  return {
    action: 'opened',
    installation: { id: 1 },
    repository: { name: 'repo', owner: { login: 'owner' } },
    pull_request: { number, draft, head: { ref: 'feature' }, base: { ref: 'main' } },
  };
}

export function fixCommentPayload({ body = '/kintsugi-fix', senderType = 'User', number = 12 } = {}) {
  return {
    action: 'created',
    installation: { id: 1 },
    repository: { name: 'repo', owner: { login: 'owner' } },
    issue: { number, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/12' } },
    comment: { body, id: 5 },
    sender: { type: senderType },
  };
}

async function installFixtureDeps(dir) {
  if (existsSync(join(dir, 'package.json')) && !existsSync(join(dir, 'node_modules'))) {
    try {
      await exec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, timeout: 300_000 });
    } catch {
      // checks that need the toolchain will report as broken harness
    }
  }
}

/**
 * Review-mode checkout stand-in: simulate `git clone` + PR-head checkout by
 * copying the real fixture into a fresh temp dir (git-initialized). The
 * engine then runs against a real checkout, exactly like production.
 */
export function makeReviewCheckout() {
  return async function checkout(owner, repo, ref, dir) {
    await mkdir(dir, { recursive: true });
    await cp(FIXTURE, dir, { recursive: true });
    await exec('git', ['init', '-q'], { cwd: dir });
    await exec('git', ['add', '-A'], { cwd: dir });
    await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
    await installFixtureDeps(dir);
  };
}

async function gitInit(dir, branch = 'main') {
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', ['branch', '-M', branch], { cwd: dir });
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
}

/**
 * Auto-fix mode checkout stand-in: same local copy, plus a bare remote so
 * the app's `git push origin kintsugi/fixes` has somewhere real to go.
 */
export function makeFixCheckout() {
  return async function checkout(owner, repo, ref, dir) {
    const parent = dirname(dir);
    const bare = join(parent, `${basename(dir)}-bare.git`);
    await mkdir(dir, { recursive: true });
    await exec('git', ['init', '--bare', '-q', bare]);
    await cp(FIXTURE, dir, { recursive: true });
    await gitInit(dir);
    await exec('git', ['remote', 'add', 'origin', bare], { cwd: dir });
    await exec('git', ['push', '-q', 'origin', 'main'], { cwd: dir });
    await installFixtureDeps(dir);
  };
}

/**
 * A repo with one check that always passes: the loop converges with zero
 * findings, proving the zero-fix path (no push, explanatory comment).
 */
export function makeCleanCheckout() {
  return async function checkout(owner, repo, ref, dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'kintsugi.config.json'), JSON.stringify({
      checks: [{ name: 'ok', command: 'node -e "process.exit(0)"', parser: 'lines' }],
      budget: 1,
      maxIterations: 3,
    }));
    await writeFile(join(dir, 'hi.txt'), 'hi');
    await gitInit(dir);
    const bare = join(dirname(dir), `${basename(dir)}-bare.git`);
    await exec('git', ['init', '--bare', '-q', bare]);
    await exec('git', ['remote', 'add', 'origin', bare], { cwd: dir });
  };
}
