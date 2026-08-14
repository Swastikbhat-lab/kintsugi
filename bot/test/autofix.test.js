import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleFixComment } from '../src/autofix.js';
import { stubOctokit, fakeContext, fixCommentPayload, makeFixCheckout, makeCleanCheckout } from './helpers.js';

test('only the exact "/kintsugi-fix" body triggers a run', async () => {
  for (const body of ['kintsugi-fix', ' /kintsugi-fix extra', '/kintsugi-fixx', 'please fix']) {
    const { octokit, calls } = stubOctokit();
    const context = fakeContext({ payload: fixCommentPayload({ body }), octokit });
    const out = await handleFixComment(context, { checkout: makeFixCheckout() });
    assert.equal(out.handled, false, `body "${body}" must not trigger`);
    assert.equal(calls.length, 0);
  }
});

test('non-PR comments and bot senders are ignored', async () => {
  const noPr = { ...fixCommentPayload(), issue: { number: 1 } }; // no pull_request
  const ctx1 = fakeContext({ payload: noPr, octokit: stubOctokit().octokit });
  assert.equal((await handleFixComment(ctx1)).handled, false);

  const bot = fakeContext({ payload: fixCommentPayload({ senderType: 'Bot' }), octokit: stubOctokit().octokit });
  assert.equal((await handleFixComment(bot)).handled, false);
});

test('a real /kintsugi-fix run applies verified repairs, pushes, and opens a PR', async () => {
  const { octokit, calls } = stubOctokit({ openPulls: [] });
  const context = fakeContext({ payload: fixCommentPayload(), octokit });
  const out = await handleFixComment(context, { checkout: makeFixCheckout() });

  // The engine really ran in git mode against a real checkout of the
  // fixture: the verify gate proved and committed at least the four
  // mechanical fixes (and rejected the wrong guess).
  assert.equal(out.handled, true);
  assert.ok(out.commits >= 4, `expected >=4 verified commits, got ${out.commits}`);

  const create = calls.find(([k]) => k === 'pulls.create');
  assert.ok(create, 'expected pulls.create');
  assert.equal(create[1].head, 'kintsugi/fixes');
  assert.equal(create[1].base, 'main');
  assert.ok(create[1].body.includes('verified'));
});

test('an existing fix PR is updated instead of duplicated', async () => {
  const { octokit, calls } = stubOctokit({ openPulls: [{ number: 5 }] });
  const context = fakeContext({ payload: fixCommentPayload(), octokit });
  const out = await handleFixComment(context, { checkout: makeFixCheckout() });

  assert.equal(out.pr, 5);
  assert.equal(calls.some(([name]) => name === 'pulls.create'), false);
  const note = calls.find(([name, params]) => name === 'createComment' && params && params.issue_number === 5);
  assert.ok(note, 'expected an update note on the existing fix PR');
});

test('zero fixes means no push, just an explanatory comment', async () => {
  const { octokit, calls } = stubOctokit({ openPulls: [] });
  const context = fakeContext({ payload: fixCommentPayload(), octokit });
  const out = await handleFixComment(context, { checkout: makeCleanCheckout() });

  assert.equal(out.handled, true);
  assert.equal(out.commits, 0);
  const note = calls.find(([k]) => k === 'createComment');
  assert.ok(note, 'expected the no-fixes note');
  assert.ok(note[1].body.includes('no verified fixes'));
  assert.equal(calls.some(([k]) => k === 'pulls.create'), false);
});
