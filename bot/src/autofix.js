import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkout, getToken, gitConfig, headSha, commitCount, pushBranch } from './github.js';
import { installDeps, runEngine } from './engine.js';

export const FIX_BRANCH = 'kintsugi/fixes';

const PR_BODY = [
  'This PR was produced by [Kintsugi](https://github.com/Swastikbhat-lab/kintsugi).',
  '',
  'Every commit is one repair, verified by re-running the checks after the change:',
  'the finding cleared **and** nothing new appeared. Anything Kintsugi could not',
  'prove, it left alone.',
  '',
  'Review the diff, then merge or close it — each commit stands on its own.',
].join('\n');

// Two "/kintsugi-fix" comments on the same repo must not race on one branch.
const queues = new Map();

/**
 * `issue_comment` handler. Commenting exactly "/kintsugi-fix" on any pull
 * request checks out the PR head, applies every repair the verify gate
 * proves, commits each one separately, pushes the branch, and opens (or
 * updates) the fix PR.
 */
export function handleFixComment(context, deps = {}) {
  const { issue, comment } = context.payload;
  if (!issue?.pull_request) return Promise.resolve({ handled: false });
  if (!comment || String(comment.body ?? '').trim() !== '/kintsugi-fix') {
    return Promise.resolve({ handled: false });
  }
  if (context.payload.sender?.type === 'Bot') {
    return Promise.resolve({ handled: false });
  }

  const repo = context.payload.repository;
  const key = `${repo.owner.login}/${repo.name}`;
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(() => runFix(context, deps)).finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  queues.set(key, next);
  return next;
}

async function runFix(context, deps) {
  const repo = context.payload.repository;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const number = context.payload.issue.number;

  const doCheckout = deps.checkout ?? checkout;
  const dir = await mkdtemp(join(tmpdir(), 'kintsugi-fix-'));
  try {
    const token = await getToken(context);
    await doCheckout(owner, repoName, `pull/${number}/head`, dir, token);
    await gitConfig(dir, 'kintsugi[bot]', 'kintsugi[bot]@users.noreply.github.com');
    await installDeps(dir);

    const base = await headSha(dir);
    const report = await runEngine({ dir, dry: false, git: true, branch: FIX_BRANCH });
    const count = await commitCount(dir, base, FIX_BRANCH);
    context.log.info(`kintsugi: /kintsugi-fix on ${owner}/${repoName}#${number} produced ${count} verified commit(s)`);

    if (count === 0) {
      await context.octokit.issues.createComment({
        owner, repo: repoName, issue_number: number,
        body: '🔧 Kintsugi: no verified fixes to propose — anything actionable was either already clean or quarantined for a human.',
      });
      return { handled: true, commits: 0 };
    }

    await pushBranch(dir, FIX_BRANCH);

    const { data: existing } = await context.octokit.pulls.list({
      owner, repo: repoName, state: 'open', head: `${owner}:${FIX_BRANCH}`,
    });
    if (existing.length > 0) {
      await context.octokit.issues.createComment({
        owner, repo: repoName, issue_number: existing[0].number,
        body: '🔄 Kintsugi has pushed new verified fixes to this PR.',
      });
      return { handled: true, commits: count, pr: existing[0].number };
    }

    const { data: pr } = await context.octokit.pulls.get({
      owner, repo: repoName, pull_number: number,
    });
    const created = await context.octokit.pulls.create({
      owner, repo: repoName,
      title: 'Kintsugi: verified fixes',
      head: FIX_BRANCH,
      base: pr.base.ref,
      body: PR_BODY,
    });
    context.log.info(`kintsugi: opened fix PR #${created.data.number}`);
    return { handled: true, commits: count, pr: created.data.number };
  } catch (err) {
    context.log.error(`kintsugi: /kintsugi-fix on ${owner}/${repoName}#${number} failed: ${err.message}`);
    return { handled: false, error: err.message };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
