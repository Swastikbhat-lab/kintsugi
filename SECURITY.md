# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**:

- **Preferred**: GitHub private vulnerability reporting — open this repo's
  **Security → Report a vulnerability** and describe the issue there.
- **Fallback**: email the maintainers at
  `swastikbhat.dev@gmail.com` (subject: `[kintsugi-security] …`).

Do **not** open a public issue for a suspected vulnerability.

### What to include

- The repo / `kintsugi.config.json` / check commands that reproduce it.
- Expected vs. actual behavior.
- Affected version or branch (commit hash if known).

## Response commitment

- **Acknowledgment within 72 hours** of a complete report.
- A fix or a mitigation plan with a target date within 14 days.
- We practice **coordinated disclosure** (default 90 days) and will credit
  you in the advisory unless you prefer anonymity.

## Scope

In scope:

- The engines: `src/` (TypeScript) and `py/` (Python).
- The packaging: `scripts/`, `bot/` (GitHub App), `action.yml`, and the
  GitHub Actions workflows.
- The check parsers and the verify gate.

Out of scope:

- Third-party toolchains the checks invoke (tsc, pytest, cargo, …) — those
  run with the privileges of whoever invokes Kintsugi and have their own
  security models.
- The repo under audit: Kintsugi runs whatever checks its config declares,
  so audit code you already trust, in an environment you control.

## Security-relevant design (what the loop does and does not do)

These properties are intentional and are not vulnerabilities:

- **Checks are commands.** The loop executes the check commands declared in
  `kintsugi.config.json` with the user's privileges — same trust model as
  running `npm test`. It never claims a fix for a check that crashed: a
  broken harness is reported as `unverifiable` and can never rubber-stamp a
  patch.
- **Patches are exact-string edits** (`find`/`replace`), applied and
  reverted deterministically. The loop never executes model-proposed code
  as an action; model tool calls (`read_file`, `grep`, `importers`) are
  engine-executed, read-only, and return bounded text.
- **Verify gate**: a patch ships only if the target finding is gone *and*
  no new finding appeared. Anything else is reverted and recorded in the
  ledger.
- **The GitHub App** reviews in dry mode (read-only clones, nothing pushed);
  `contents: write` is only exercised by the explicit `/kintsugi-fix`
  command, which pushes a branch the human reviews.
- **No telemetry by default.** The loop writes only its local ledger and
  report files; external observability (Langfuse, audit log) is opt-in and
  requires keys you configure.
