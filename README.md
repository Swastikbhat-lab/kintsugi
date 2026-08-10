# Kintsugi

Finds interface defects in a running web app by measuring the rendered page,
repairs the ones that have an objectively correct fix, and re-measures to
confirm the repair worked. Anything it cannot verify, it reverts.

Point it at a dev server and the repo that builds it.

```bash
npm install && npx playwright install chromium
npm run cli -- --target http://localhost:5173 --source ./frontend --routes /login --dry
```

`--dry` surveys without writing anything, which is how a first run on an
unfamiliar codebase should start.

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
rule reaches: overlapping controls, console errors, what an animation should
do instead, and the accessibility rules that need to know what the content
means (alt text, accessible names, labels). Those are the majority of what is
detected and none of them have a mechanical fix.

### Enabling it

Set a credential in your own environment — the tool reads it from there and
never stores or transmits it:

```powershell
$env:ANTHROPIC_API_KEY = "..."      # PowerShell, current session
setx ANTHROPIC_API_KEY "..."        # persist it
```

Any credential source the Anthropic SDK understands works, including an
`ant auth login` profile; the tool does not look for one variable in
particular.

On startup it makes one cheap call to check the credential and the request
shape, then reports `Model proposer reachable` or the specific reason it is
not. That check exists because a bad credential and a model with no suggestion
both produce zero patches, and only one of those is a problem.

> **Status: the model path has not yet been exercised against the live API.**
> It typechecks, degrades safely, and reports its own failures, but no run has
> confirmed a model-proposed patch surviving verification. Treat the first run
> with a credential as the real test. Everything the tool has actually fixed
> so far came from the deterministic rules.

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

## Which standard is being enforced

Thresholds are choices, not facts, and sources disagree. A 24×24 touch target
is the WCAG 2.2 Level AA minimum; 44×44 is the Level AAA enhanced criterion
and what most mobile guidance recommends. Both are right, for different
commitments — so the profile is selected once, explicitly, and every finding
records the profile and rule that produced it.

```bash
npm run cli -- ... --policy mobile-touch
```

| Profile | Contrast | Target size |
|---|---|---|
| `wcag-22-aa` *(default)* | 4.5 / 3.0 | 24px |
| `wcag-22-aaa` | 7.0 / 4.5 | 44px |
| `mobile-touch` | 4.5 / 3.0 | 44px |
| `botstacks-product` | 4.5 / 3.0 | 24px |
| `performance-strict` | not assessed | not assessed |

The fixture carries a deliberate 30×30 control: it clears AA and fails the
enhanced criterion, so switching profiles visibly changes whether it is a
defect. `performance-strict` reports contrast and target size as *not
assessed* rather than passing — a profile that does not examine something must
never read as having approved it.

This is also the only correct way to absorb external design guidance. A source
recommending 44px targets becomes a profile someone selects, not a number that
quietly replaces the compliance floor.

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

## Against the BotStacks frontend

Start the frontend dev server, then survey without writing anything:

```bash
npm run dev --prefix botstacks-sandbox-build/frontend      # serves :5173

npm run cli -- \
  --target http://localhost:5173 \
  --source ../botstacks-sandbox-build/frontend \
  --routes /login,/forgot-password \
  --dry
```

Pages behind the login need a browser you have already signed into — see
"Reaching real apps" above. It never handles credentials itself.

Two things to expect on this codebase specifically. Most contrast findings
resolve to shared tokens in `src/theme/tokens.css`, so they are reported with
a use-site count rather than applied — `--color-primary` alone is referenced
in over 300 places, and changing it is a palette decision. And styles that
come from Tailwind utilities in markup have no CSS rule to patch, so those are
reported only; CSS Modules are resolved back to their authoring names and can
be patched normally.

Add `--git` to commit each verified fix separately on its own branch. It
requires a clean tree, so its edits never mix into work in progress.

## Running it continuously

A single run is a snapshot. On a cadence it becomes maintenance — the
interface stays repaired as the app changes, instead of being repaired once
and drifting.

Locally:

```bash
npm run cli -- --target http://localhost:5173 --source ../frontend \
  --routes /login,/dashboard --watch 30
```

Each cycle reports only what moved. A cycle that changed nothing prints one
line, so a cadence you actually leave running does not train you to ignore it.

The ledger is what makes repetition safe rather than wasteful: attempts
persist per target, so each cycle starts knowing which patches earlier cycles
already disproved instead of re-proposing them forever. Successive cycles
converge — on the fixture, 8 outstanding becomes 7, then 5, then 3, and the 3
that remain are the ones with no mechanical rule.

### On a schedule, in CI

`.github/workflows/scheduled-repair.yml` is a reusable workflow. The app's
repository calls it, and the run boots that app, walks the routes, and opens a
pull request containing only fixes that survived verification:

```yaml
name: UI repair
on:
  schedule: [{ cron: "0 6 * * 1" }]   # Mondays, 06:00 UTC
  workflow_dispatch:

jobs:
  repair:
    uses: Swastikbhat-lab/kintsugi/.github/workflows/scheduled-repair.yml@main
    with:
      frontend-repo: BotStacks/botstacks-sandbox-build
      working-directory: frontend
      routes: /login,/forgot-password
      dry-run: true          # report only; flip once a first run is reviewed
    secrets:
      repo-token: ${{ secrets.GITHUB_TOKEN }}
```

Start with `dry-run: true`. It writes nothing and puts the findings in the job
summary, which is the right way to see what a scheduled run would do to your
repository before letting it do so.

A pull request rather than a push to a tracked branch, deliberately: the loop
proves a defect cleared, not that the change was wanted. Each commit is one
fix and can be taken or dropped on its own.

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
