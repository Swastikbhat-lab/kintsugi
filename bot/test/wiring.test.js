import { test } from 'node:test';
import assert from 'node:assert/strict';
import createKintsugiApp from '../index.js';

test('the app registers pull_request and issue_comment handlers', () => {
  const handlers = {};
  const app = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
  };
  createKintsugiApp({ app });

  assert.equal(typeof handlers.pull_request, 'function');
  assert.equal(typeof handlers.issue_comment, 'function');
  assert.equal(Object.keys(handlers).length, 2);
});
