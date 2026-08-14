import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Installation-scoped raw token, used for git over HTTPS. */
export async function getToken(context) {
  const { token } = await context.octokit.auth({ type: 'installation' });
  return token;
}

async function git(cwd, args) {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

/**
 * Clone the repo (shallow) and check out an arbitrary ref — typically
 * `pull/<number>/head` so reviews run against the PR's actual code.
 * The token-carrying remote URL is kept, so a later `git push` in the same
 * checkout (the /kintsugi-fix path) works without re-authenticating.
 */
export async function checkout(owner, repo, ref, dir, token) {
  const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  await git(process.cwd(), ['clone', '--depth', '1', url, dir]);
  await git(dir, ['fetch', '--depth', '1', 'origin', `${ref}:refs/remotes/origin/kintsugi-head`]);
  await git(dir, ['checkout', 'kintsugi-head']);
}

export async function gitConfig(dir, name, email) {
  await git(dir, ['config', 'user.name', name]);
  await git(dir, ['config', 'user.email', email]);
}

export async function headSha(dir) {
  return git(dir, ['rev-parse', 'HEAD']);
}

export async function commitCount(dir, fromRef, toRef) {
  const out = await git(dir, ['rev-list', '--count', `${fromRef}..${toRef}`]);
  return Number.parseInt(out, 10) || 0;
}

export async function pushBranch(dir, branch) {
  await git(dir, ['push', 'origin', branch]);
}
