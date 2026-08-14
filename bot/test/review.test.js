import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPullRequest } from '../src/review.js';
import { stubOctokit, fakeContext, pullRequestPayload, makeReviewCheckout } from './helpers.js';
import { REVIEW_MARKER } from 'kintsugi/scripts/render-report.mjs';

test('draft PRs are skipped without touching anything', async () => {
  const { octokit, calls } = stubOctokit();
  const context = fakeContext({ payload: pullRequestPayload({ draft: true }), octokit });
  const out = await reviewPullRequest(context);
  assert.equal(out.reason, 'draft');
  assert.equal(calls.length, 0);
});

test('a non-draft PR is reviewed: real engine run, comment posted with findings', async () => {
  const { octokit, calls } = stubOctokit({ comments: [] });
  const context = fakeContext({ payload: pullRequestPayload(), octokit });
  const out = await reviewPullRequest(context, { checkout: makeReviewCheckout() });

  assert.equal(out.handled, true);
  const create = calls.find(([k]) => k === 'createComment');
  assert.ok(create, 'expected a comment to be created');
  const body = create[1].body;
  assert.ok(body.includes('Kintsugi review'), 'comment carries the review title');
  assert.ok(body.includes(REVIEW_MARKER), 'comment carries the update marker');
  assert.ok(body.includes('repair available'), 'fixture findings with a mechanical fix are listed');
  assert.equal(create[1].issue_number, 12);
});

test('an existing review comment is updated, never duplicated', async () => {
  const { octokit, calls } = stubOctokit({ comments: [{ id: 7, body: `old review\n${REVIEW_MARKER}` }] });
  const context = fakeContext({ payload: pullRequestPayload({ number: 3 }), octokit });
  await reviewPullRequest(context, { checkout: makeReviewCheckout() });

  assert.equal(calls.filter(([k]) => k === 'createComment').length, 0);
  const update = calls.find(([k]) => k === 'updateComment');
  assert.ok(update, 'expected an update, not a new comment');
  assert.equal(update[1].comment_id, 7);
  assert.equal(update[1].issue_number, undefined); // update goes by comment_id
});

test('a failed review surfaces a short failure comment', async () => {
  const { octokit, calls } = stubOctokit({ comments: [] });
  const context = fakeContext({ payload: pullRequestPayload(), octokit });
  const boom = async () => { throw new Error('checkout exploded'); };
  const out = await reviewPullRequest(context, { checkout: boom });

  assert.equal(out.handled, false);
  const create = calls.find(([k]) => k === 'createComment');
  assert.ok(create, 'expected a failure comment');
  assert.ok(create[1].body.includes('failed'));
});
