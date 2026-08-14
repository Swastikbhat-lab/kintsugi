# Kintsugi GitHub App (Probot)

The Kintsugi review bot as a proper **GitHub App**, so it can review pull
requests on *any* repo where it's installed — no copying workflow files.

- On every `pull_request` (opened / synchronized / reopened) it clones the
  PR head, runs the loop in **dry mode**, and posts (or updates) a findings
  comment: what's mechanically fixable, what's escalated, what needs a human.
  Nothing is ever written back during a review.
- Commenting **`/kintsugi-fix`** on any PR makes it apply every repair the
  verify gate proves, commit each one separately on `kintsugi/fixes`, push
  the branch, and open (or update) a fix PR.

This is the same engine and the same comment renderer as the
[GitHub Action](../.github/workflows/pr-review.yml) — the app just removes
the "copy this workflow into your repo" step.

## How it differs from the Action

| | GitHub Action (workflow) | GitHub App (this) |
|---|---|---|
| Install | copy a `.yml` into the repo | install the app once, works on every repo you grant it |
| Runs on | GitHub-hosted runners (each PR = fresh VM) | your own host (one server, shared engine cache) |
| Fix PRs | `/kintsugi-fix` comment or manual dispatch | `/kintsugi-fix` comment |
| Review scope | whatever the workflow checks out | PR head, always |
| Cost | GitHub Actions minutes | one small VM |

Use the Action if you want zero infrastructure; use the App if you manage
many repos or want reviews on repos you can't edit.

## Install

1. **Create the app**: go to
   https://github.com/settings/apps/new and paste `app.yml` (or use the
   manifest flow — GitHub creates the app, webhook, and key for you).
   Save the **App ID** and the **private key**; note the **webhook secret**.
2. **Deploy** the app anywhere Node ≥ 22 runs (Render, Fly.io, Railway, a
   VPS, or `localhost` with a smee tunnel for development):

   ```bash
   cd bot
   npm install            # also builds the kintsugi engine (file: ../ dep)
   cp .env.example .env   # fill in APP_ID, PRIVATE_KEY, WEBHOOK_SECRET
   npm start              # probot run ./index.js
   ```

   The webhook URL GitHub must call is
   `https://<your-host>/api/github/webhooks` (Probot 13's default webhook
   path).
3. **Install the app** on the repositories (or organizations) you want
   reviewed: your GitHub App page → *Install App*.
4. Open a PR. The bot comments within a minute. Comment `/kintsugi-fix` to
   get the verified-fix PR.

## What it needs on the host

- **Node ≥ 22, git, npm** (the engine itself). The target repo's own checks
  run on the host, so checks that need Python/Rust/Go only work if those
  toolchains are installed too — a missing tool reports as a *broken
  harness*, never a healed defect.
- The engine installs the target repo's npm dependencies best-effort
  (`npm ci`) so `typecheck`/`test` checks can run. Repos that need private
  packages or a different package manager will surface those checks as
  broken harnesses until the host is set up for them.

## Configuration (env)

| Var | Meaning |
|---|---|
| `APP_ID` | GitHub App ID |
| `PRIVATE_KEY` | GitHub App private key (PEM) |
| `WEBHOOK_SECRET` | webhook secret set at app creation |
| `WEBHOOK_PROXY_URL` | smee.io tunnel for local development only |
| `KINTSUGI_CLI` | override the engine CLI path |
| `ANTHROPIC_API_KEY` | optional — enables the model proposer for findings no rule reaches |

## Permissions & why

- `contents: write` — pushes the `kintsugi/fixes` branch on `/kintsugi-fix`.
  Reviews themselves only *read*.
- `issues: write` + `pull_requests: write` — post/update PR comments and the
  fix PR. (PR comments go through the issues API.)
- `metadata: read` — always required.

## Development

```bash
cd bot
npm install
npm test    # node --test — runs the REAL engine + git against the fixture;
            # only the GitHub HTTP API is stubbed
```

The tests prove: draft PRs are skipped, reviews post/update one comment with
the findings table, `/kintsugi-fix` applies ≥4 verified repairs and opens a
PR, existing fix PRs are updated not duplicated, and a clean repo yields an
explanatory no-fixes comment.
