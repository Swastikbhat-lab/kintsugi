# Kintsugi

Self-healing UI. Point it at a running web app and a repo it may edit; it
models the interface as a graph, then repairs it in loops that verify their
own work.

The name is the pottery repair that leaves the seam visible in gold. Nothing
here hides that a repair happened — every patch is recorded with what it was
for and whether it survived.

Three ideas, layered: an **agent** proposes, a **loop** makes it reliable, a
**graph** makes it fast. Each one only earns its place because the one below
it holds.

## The loop

```
observe → diagnose → repair → verify → settle
   ↑                                      │
   └──────────────────────────────────────┘
```

- **observe** — drive a real browser over each route, measure the live DOM,
  emit signals and findings.
- **diagnose** — rank findings worst-first, skip anything the ledger says is
  a known dead end.
- **repair** — propose the smallest exact-string edit that could clear it.
- **verify** — re-observe the same surface. Keep the patch only if the finding
  is gone *and* nothing new appeared. Otherwise revert.
- **settle** — stop when nothing actionable is left, or the iteration budget
  is spent.

Verify is the load-bearing phase. A repair loop without it will confidently
apply changes that do nothing, and a loop that also lacks the collateral check
will trade one defect for two.

## The work graph

Each iteration is a graph of jobs, not a script. A node is one unit of work
with one defined input and one defined output; an edge is a real dependency —
the next node consumes what the previous one produced. Anything without an
incoming edge starts immediately.

```
observe(/)  observe(/settings)  observe(/billing)   ← independent → concurrent
       └──────────────┬──────────────┘
                   reduce                            ← plain code, no model
                      │
                   diagnose                          ← rank, consult the ledger
                      │
                   propose                           ← the only creative step
                      │
        ┌─────────────┼─────────────┐
     correct?    collateral?      valid?             ← fresh context each
        └─────────────┼─────────────┘
                    gate                             ← majority vote
                      │
                   verify                            ← apply, re-measure, decide
```

Two rules the shape enforces:

**Every node declares its output contract.** A result that does not match is
rejected and retried rather than passed downstream, so a malformed result
fails where it was produced instead of corrupting whatever consumes it.

**The tail is serial, and must stay that way.** Repair and verify cannot run
concurrently: two patches applied at once destroy verify's ability to say
which one caused what. That edge is a real dependency, not a leftover from
writing the steps in order.

## The UI graph

A separate graph, and a different object — this one models the interface
rather than the work. Three node kinds:

| Kind | Is | Example |
|---|---|---|
| `surface` | an addressable screen | `/settings` |
| `region` | a component subtree | `.sidebar` |
| `signal` | one measured property | contrast of `p.subtle` = 2.56 |

Passing signals are nodes too, not just failing ones. That is deliberate — a
node that vanishes when it is healed makes it impossible to watch anything
improve, and passing signals are exactly what must not regress when something
next to them is patched.

## Self-improvement

`.kintsugi/ledger.json` in the target repo records every attempt as
`fingerprint → patch → outcome`. On the next encounter with the same defect:

- a patch shape that committed before is tried first
- a patch shape that was ineffective or regressed is not tried again
- a finding with no untried candidates left is quarantined for a human rather
  than looped on

Without the ledger the loop rediscovers the same dead end on every run. That
is the failure mode that makes naive auto-fixers oscillate.

## Where the model goes

Exactly one phase is allowed to be creative:

```
observe   ← deterministic (a measurement must not be invented)
diagnose  ← deterministic (ranking is arithmetic)
propose   ← the model belongs HERE, and only here
verify    ← deterministic (a model grading its own patch is not a gate)
```

Rules run first — free, instant, and already proven on contrast, tap targets,
tracking, leading, and reduced motion. The model is consulted only for what no
rule reaches. Set `ANTHROPIC_API_KEY` to enable it; without one the loop runs
rules-only and says so.

Two safeguards on model-proposed patches. First, three **checkers** review the
diff in parallel — is it correct, does it reach beyond the defect, is the
anchor unique — each with a fresh context that has never seen the proposer's
reasoning. A checker that reads the worker's argument is agreeing with it, not
checking it. Second, a model-supplied file path is untrusted input: anything
resolving outside the source root is dropped, not sanitised into place.

The checkers are advisory. The gate that actually decides is the browser.

## What it can and cannot improve

| Defect | Detect | Mechanical fix | Status |
|---|---|---|---|
| Contrast | formula | solve for the ratio | fixed by rules |
| Tap target | a number | raise to 24px | fixed by rules |
| Tracking on display type | measured | `-0.02em` | fixed by rules |
| Leading on display type | measured | tighten ratio | fixed by rules |
| Reduced motion absent | CSSOM walk | append the media block | fixed by rules |
| Clipped text | measured | depends why | needs a model |
| Non-compositor transition | measured | needs intent | needs a model |
| Press feedback absent | CSSOM walk | needs a design language | needs a model |
| Overlap, console errors | measured | needs intent | reported only |
| "This hierarchy is confusing" | — | — | outside the loop |

The last row is the boundary, not a gap. A model widens what can be
*proposed*; it never widens what can be *checked*. A defect with no objective
check cannot be looped on at all, and pretending otherwise is how a loop
becomes an expensive way to generate drafts.

## Blast radius — the check verification cannot do

A patch is only safe to apply automatically when its effect stops at the
defect. Three scopes:

| Scope | Anchor | Applied? |
|---|---|---|
| `component` | a class rule used in one place | yes |
| `token` | a shared design token | escalated |
| `global` | a bare element rule (`a { }`) | escalated |

The verify gate cannot catch the last two, and this is the important part:
retinting a token genuinely clears the contrast measurement, and a
`min-height` on `a { }` genuinely fixes the tap target. The finding clears,
the loop sees green, and the damage lands somewhere it was not looking.
So blast radius is decided before the patch is applied, not after, from what
the anchor *is* — with the number of use sites attached so the owner can judge
it. `--allow-tokens` overrides.

## Reaching real apps

**Source mapping.** The DOM reports `_forgot_penvp_415`; the file says
`.forgot`. Scoped names are resolved back to their authoring name before any
patch is anchored, so healers work on CSS-Modules apps rather than silently
finding nothing. Tailwind utilities are detected and skipped — they have no
rule to patch.

Scoped names also make fingerprints unstable, which is subtler and worse. Vite
derives the hash from the whole stylesheet, so editing one rule renames every
class in that file — and every untouched finding there reads as newly
appeared. Left alone, the loop scores that as collateral and reverts correct
patches. Findings are therefore fingerprinted on the authoring name.

**Signed-in pages.** Most of an app is behind a login, and Kintsugi must never
be given a credential. `--attach http://127.0.0.1:9222` connects to a browser
you signed into yourself and drives that session, reusing its context. It
closes only the pages it opened and never the browser.

> Use `127.0.0.1`, not `localhost` — on Windows `localhost` resolves to `::1`
> first, and Chrome's debugging port binds IPv4 only.

## Running it

```bash
npm install
npx playwright install chromium
npm run build:web
npm start          # dashboard + API on :4180
```

Headless, for CI:

```bash
npm run cli -- --target http://localhost:5173 --source ./app --routes /,/settings
```

Exits non-zero while findings remain, so it can gate a pipeline.

| Flag | Effect |
|---|---|
| `--dry` | survey every finding, write nothing |
| `--allow-tokens` | permit app-wide changes that would otherwise escalate |
| `--attach <cdp>` | drive a browser you already signed into |
| `--routes`, `--max` | routes to walk, iteration ceiling |

State lives in `~/.kintsugi/ledgers/`, keyed by source root — never inside the
repo under audit. Kintsugi is pointed at codebases it does not own, and
leaving an untracked directory in someone's working tree is not its to make.

## What it will not do

Deliberate limits, each because the alternative produces confident wrong
answers:

- **Contrast on gradients or translucent stacks is reported as unmeasurable,
  not as a ratio.** Compositing computed styles down to the nearest solid
  ancestor silently measures against a background nobody can see. Dark themes
  hit this constantly. These land on the graph as hollow nodes so the gap is
  visible, and need a human or a screenshot.
- **No static analysis of stylesheets.** A rule's resolved value depends on
  cascade, theme and runtime state. Reading the stylesheet produces failures
  nobody can reproduce.
- **Console errors and overlapping elements are reported, never patched.**
  Both need reasoning about intent; a mechanical edit would be a guess.
- **Patches are confined to `sourceRoot`** and applied to the first match
  only. A patch matching in several places is ambiguous, and applying it
  everywhere is how one contrast fix quietly restyles half an app.

## Layout

```
src/
  types.ts            domain model
  loop.ts             the engine
  observe.ts          Playwright driver, graph construction
  detectors/          in-page probes (contrast, layout)
  heal/
    propose.ts        finding → candidate patches
    ledger.ts         attempt history, prioritisation, quarantine
  server.ts           API + SSE + dashboard host
  cli.ts              headless entry point
web/                  dashboard (Vite + React)
fixture/              app with known defects, for testing the loop
```

## Fixture

`fixture/` carries three planted defects and one control rule that must not
change. A run against it should commit two patches, revert and quarantine the
clipping defect (its container has a fixed width and the child sets
`white-space: nowrap`, so wrapping cannot help), and leave `.ok` untouched.
