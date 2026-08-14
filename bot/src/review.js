import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown, REVIEW_MARKER } from 'kintsugi/scripts/render-report.mjs';
import { checkout, getToken } from './github.js';
import { installDeps, runEngine } from './engine.js';

const FAILURE_COMMENT = `## 🔧 Kintsugi review

⚠️ The review run failed — nothing was written to this branch. See the app logs for details.

${REVIEW_MARKER}`;

/**
 * `pull_request` handler. Runs the loop in dry mode against the PR head and
 * posts (or updates) the findings comment. Review only — the checkout is a
 * throwaway clone and nothing is ever pushed back.
 */
export async function reviewPullRequest(context, deps = {}) {
  const pr = context.payload.pull_request;
  if (!pr) return { handled: false };

  const repo = context.payload.repository;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const number = pr.number;

  if (pr.draft) {
    context.log.info(`kintsugi: skipping draft PR #${number}`);
    return { handled: false, reason: 'draft' };
  }

  const doCheckout = deps.checkout ?? checkout;
  const dir = await mkdtemp(join(tmpdir(), 'kintsugi-review-'));
  try {
    const token = await getToken(context);
    await doCheckout(owner, repoName, `pull/${number}/head`, dir, token);
    await installDeps(dir);

    const report = await runEngine({ dir, dry: true });
    const body = renderMarkdown(report);

    const { data: comments } = await context.octokit.issues.listComments({
      owner, repo: repoName, issue_number: number,
    });
    const prev = comments.find((c) => c.body && c.body.includes(REVIEW_MARKER));
    if (prev) {
      await context.octokit.issues.updateComment({
        owner, repo: repoName, comment_id: prev.id, body,
      });
    } else {
      await context.octokit.issues.createComment({
        owner, repo: repoName, issue_number: number, body,
      });
    }
    return { handled: true };
  } catch (err) {
    context.log.error(`kintsugi: review of ${owner}/${repoName}#${number} failed: ${err.message}`);
    try {
      await context.octokit.issues.createComment({
        owner, repo: repoName, issue_number: number, body: FAILURE_COMMENT,
      });
    } catch {
      // best-effort; the log above is the record
    }
    return { handled: false, error: err.message };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
