# The loop

```
observe → diagnose → repair → verify → settle
   ↑                                      │
   └──────────────────────────────────────┘
```

## observe

Run the failing checks. The contract with a check is one sentence: **give me
typed failures** — file, line, code, message. Built-in parsers understand
`tsc` output, TAP (Node's test runner), and plain `path: message` lines, so
a custom check is a shell command that prints problems.

A check that exits non-zero with no parseable finding is a **crash**, not a
defect. A broken harness must not be healed — the loop reports it and moves
on, because a repair loop that "heals" its own plumbing will rewrite working
code.

## diagnose

Rank worst-first by severity, then pick one target. Consult the ledger
before proposing anything: a finding that has been tried to exhaustion is
skipped (quarantined), and a patch shape the ledger has disproved is never
proposed again.

## repair

Produce the smallest exact-string edit that could clear the finding. The
order matters: **rules first** (free, instant, deterministic), then the
model for what no rule reaches. A candidate patch is one `Edit`: a file, a
verbatim anchor, a replacement. Nothing here rewrites a file wholesale or
reformats around the change — a large edit makes the verify step unable to
attribute the result.

Blast radius is decided here too, from what the file *is* (its importer
count in the import graph), never from how the patch looks. A repair to a
file two modules import is a shared-file change: reported with the count,
escalated unless overridden.

## verify — the load-bearing phase

Apply the patch, re-run the checks, and keep the patch only if:

1. the target finding is **gone**, and
2. **nothing new appeared** — the collateral check.

Both conditions must hold. A loop without step 1 will confidently apply
changes that do nothing. A loop without step 2 will trade one defect for
two. A check that crashes during verification proves nothing, so it cannot
count as success: the patch is reverted.

## settle

Stop when nothing actionable is left or the iteration budget is spent. A
finding with no untried candidates is quarantined — surfaced with its
evidence for a human, and never looped on again. Convergence means: every
defect either has a verified fix applied, or is in a human's inbox with
numbers attached.

## Why the ledger exists

Every attempt is recorded as `fingerprint → patch → outcome`. Without it the
loop rediscovers the same dead end on every run — which is the failure mode
that makes naive auto-fixers oscillate. With it, a schedule becomes
maintenance: the checks stay green as the codebase changes, instead of being
repaired once and drifting.
