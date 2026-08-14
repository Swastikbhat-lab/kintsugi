import { reviewPullRequest } from './review.js';
import { handleFixComment } from './autofix.js';

/**
 * Probot app factory.
 *
 *   export default createKintsugiApp;   // index.js
 *
 * Probot calls the factory with the app instance: `createKintsugiApp(app)`.
 * Tests call it as `createKintsugiApp({ app, deps })` to inject a fake
 * checkout (a real git clone needs a GitHub token). Both shapes work.
 */
export default function createKintsugiApp(input, second) {
  const isApp = typeof input?.on === 'function';
  const app = isApp ? input : input?.app;
  const deps = isApp ? (second?.deps ?? input?.deps) : input?.deps;

  app.on('pull_request', (context) => reviewPullRequest(context, deps));
  app.on('issue_comment', (context) => handleFixComment(context, deps));
}
