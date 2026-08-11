---
name: kintsugi
description: Self-healing repair loop for codebases. When checks fail (tests, typecheck, lint, build, custom scripts), observe the failures, repair the ones with a provable fix, verify every repair by re-running the checks, and quarantine the rest with evidence. Use when a check command fails and you want minimal, verified, auto-repaired fixes — or to run the observe→diagnose→repair→verify→settle loop over any defect with a measurable check.
---

# Kintsugi

Repair defects in a codebase the way the craft repairs a cracked bowl — fill
the gaps, and only keep what survives being tested. This skill is the
generalized version of the loop that originally repaired web UI: instead of
measuring a rendered page, it measures **anything a check command can
report**.

The loop has five phases. Only one of them is allowed to be creative.

```
observe → diagnose → repair → verify → settle
```

## Quick start

The engine ships in this repo and boots itself. From **any** repo, with this
skill installed:

```bash
~/.claude/skills/kintsugi/scripts/run-loop.sh --source . --dry   # survey, write nothing
~/.claude/skills/kintsugi/scripts/run-loop.sh --source .         # repair
```

The script locates (or bootstraps) the engine at `~/.kintsugi/engine` and
resolves relative paths against the repo you run it from. In the engine repo
itself:

```bash
npm install                          # once
npm run demo                         # watch it repair the bundled fixture
npm run cli -- --source <target-repo> --dry    # survey a real repo, write nothing
```

Against a real repo with failing checks, the five phases are:

1. **observe** — run the failing checks. Capture *typed* failures: file,
   line, code, message. A check that crashes with no parseable output is a
   broken harness, not a defect — never heal it.
2. **diagnose** — rank worst-first (blocker → major → minor). Skip anything
   the ledger says is a dead end.
3. **repair** — propose the smallest exact-string edit that could clear the
   finding. Rules first (dead declarations, unresolvable imports, missing
   exports, version drift); a model only when no rule reaches.
4. **verify — the load-bearing phase** — apply the edit, re-run the checks,
   keep the patch only if the finding is gone **and** nothing new appeared.
   Otherwise revert.
5. **settle** — stop when nothing actionable is left, or the budget is
   spent. Quarantine the rest for a human, with the evidence attached.

## Invariants (do not break these)

- **Verify is the gate.** Never ship a repair you did not re-run the checks
  on. A loop that skips this confidently applies changes that do nothing —
  and one that skips the collateral check trades one defect for two.
- **The proposer is the only creative step.** Observation must not invent a
  failure; ranking is arithmetic; verification is re-running the checks. A
  model proposing a patch is fine — a model grading its own patch is not a
  gate.
- **Blast radius is decided before the patch is applied.** A repair confined
  to one file is safe to apply. A repair to a file other modules import
  moves code the loop is not looking at — report it with the importer
  count, never apply it silently.
- **The ledger makes repetition safe.** Record every attempt as
  `fingerprint → patch → outcome`. A patch shape that failed once is never
  tried again; a finding with no untried candidates left is quarantined,
  not looped on.

## The fleet (agents)

Each iteration deploys a multi-agent work graph. The engine runs it in
-process; the same roles also ship as Claude Code subagents (`.claude/agents/`
in this repo, installed user-wide at `~/.claude/agents/`) for driving the
loop by hand:

- **kintsugi-observer** — one per check, concurrent: run the check, report
  typed findings, never invent a failure, never call a crash a defect.
- **kintsugi-healer** — the only creative step: smallest exact-string repair,
  mechanical rules first, model reasoning for the rest; blast radius decided
  before the patch.
- **kintsugi-critic** — several in parallel, each with a fresh context:
  independent keep/reject vote on a candidate patch.
- **kintsugi-verifier** — strictly serial tail: apply, re-run the checks,
  keep only if the finding is gone and nothing new appeared; otherwise
  revert, byte-for-byte.

The majority of critics decides; the verifier is the gate; the ledger makes
repetition safe. See GRAPH.md for the topology.

## What it refuses to do

- Ship an unverified repair.
- "Heal" a check that crashed instead of failing.
- Patch a shared file without explicit permission.
- Guess when the anchor text is not unique.
- Loop forever on a finding that cannot be fixed — it quarantines with
  evidence.

## Deeper reading

- [LOOP.md](LOOP.md) — the five phases and the reasoning behind each.
- [GRAPH.md](GRAPH.md) — the multi-agent work graph, and why the tail is
  serial.
- [REFERENCE.md](REFERENCE.md) — check config, parsers, patch format,
  ledger, CLI flags, mock proposals.

## Example

`fixture/` in this repo is a package with six planted defects across four
check domains (tests, typecheck, lint, version drift). `npm run demo`
repairs five of them and quarantines the sixth — including a deliberate
wrong guess that the verify gate rejects and the ledger remembers. Read
`docs/OVERVIEW.md` for the evidence from a real run.
