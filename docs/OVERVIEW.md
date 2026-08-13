# Kintsugi 2.0 — status and evidence

A working generalization of the self-healing loop. Where v1 measured a
rendered web interface and repaired its CSS, this version measures **anything
a check command can report** — tests, typecheck, lint, custom scripts — and
repairs the defects with a provably correct edit. Same five phases, same
ledger, same blast-radius rule, same multi-agent graph. Packaged as a Claude
skill (see `skills/kintsugi/`).

## What it does

Point it at a repo and its check commands. It runs the checks, produces a
list of defects with numbers attached, and for each defect with a mechanical
fix it edits the source, re-runs the checks, and keeps the patch only if the
finding is gone **and** nothing new appeared. Anything else is reverted and
recorded, so the same dead end is never retried.

The re-run is the whole design. Without it, a tool like this applies changes
that look right and silently do nothing, or fixes one thing by breaking
another.

## The fixture

`fixture/` is a tiny TypeScript package with six planted defects across four
check domains:

| Check | Defect | Repair |
|---|---|---|
| lint | unused `TAX_RATE` constant (TS6133) | rule: remove the dead declaration |
| typecheck | import of `./shipping-costs.js`, no such module (TS2307) | rule: point at `./shipping.js` |
| typecheck | import of `lineTotal`, declared but not exported (TS2459) | rule: add the `export` keyword |
| test | `applyTax` returns 8%, tests assert 10% | model (mock): wrong guess rejected, right one verified |
| version | README says 0.1.0, package.json says 0.2.0 | rule: replace from package.json |
| typecheck | import of `loadConfig`, no such function anywhere (TS2305) | **quarantined** — writing it needs intent |

The control: a passing test that any "fix" must not break — breaking it is
collateral and gets reverted.

## The fixture run

The loop pointed at the fixture with the mock proposer (the keyless replay
of the LLM path), a fresh ledger, and default settings. Real `tsc`, real
`node --test`, real custom check. Everything below is verbatim from the run.

```
CONVERGED after 8 iteration(s)
5 committed · 1 reverted · 0 escalated · 0 rejected · 1 quarantined
0 actionable finding(s) remaining

✓ The fixture test asserts 10% on $100, so the rate is 0.10.  (src/pricing.ts)
✓ No module './shipping-costs.js' exists; the code lives at './shipping.js'.  (src/app.ts)
✓ lineTotal exists in the module but is not exported — adding the export keyword.  (src/pricing.ts)
✓ Declaration TAX_RATE is never read — removing the dead line.  (src/pricing.ts)
✓ Version 0.1.0 is stale; package.json declares 0.2.0.  (README.md)
? no candidate patch for typecheck: TS2305: Module '"./config.js"' has no exported member 'loadConfig'.
```

The interesting part is the one **reverted** attempt. The mock's first
candidate for the failing test was a 5% tax rate — deliberately wrong. The
loop applied it, re-ran the tests, found the finding still present, reverted
it, and recorded the dead end in the ledger. On the next iteration the
ledger skipped that candidate and the second proposal (10%) survived
verification. That is the whole design in miniature: the model proposes, the
checks decide, and the ledger makes the loop learn from the miss rather than
repeat it.

## What it can and cannot fix

| Defect class | Has a mechanical rule? | Applied? |
|---|---|---|
| dead declarations (unused const/let/var) | yes | yes |
| unresolvable import paths | yes (basename resolution) | yes |
| missing `export` keywords | yes (when the declaration exists) | yes |
| missing import extensions (NodeNext) | yes | yes |
| stale version strings | yes (package.json is ground truth) | yes |
| unused imports (Python `F401`, Go, Rust `use`) | yes | yes |
| unsorted import blocks (Python `I001`) | yes (isort-style) | yes |
| `x == None`, `x == True`, `not x in y`, `not x is y` (`E711`–`E714`) | yes (identity / `not in` / `is not` rewrites) | yes |
| `type(x) == T` (`E721`) | yes (`isinstance` rewrite; identity when both sides are `type()` calls) | yes |
| `type(x) == T`, `len(x) == 0`, `key in d.keys()` (`T201`–`T203`) | yes (`isinstance`, truthiness, `in d`) | yes |
| wrong constant behind a failing assertion (py/go/rust) | yes (recomputed from the assertion) | yes |
| functions with no tests (Python `T001`) | yes (generated smoke test, run through the gate) | yes |
| hardcoded secrets (bandit `B105`, `T105`) | yes (moved to `os.environ`) | yes |
| weak hashes (bandit `B324`) | yes (explicit `usedforsecurity=False`) | yes |
| wrong behaviour behind a failing test | no rule — model proposes | only after the checks verify |
| missing functions / missing features | no | quarantined with evidence |
| "this design is confusing" | — | outside the loop |

A model widens what can be *proposed*; it never widens what can be *checked*.
A defect with no objective check cannot be looped on at all.

## What is not finished

- **A live model run.** The Anthropic path typechecks and degrades safely,
  but no run has confirmed a model-proposed patch surviving verification —
  treat the first run with a credential as the real test. The mock path
  exercises the identical flow, including the learn-from-a-miss story above.
- **More rule classes.** The comparison-style family (`E711`–`E714`) and
  type comparison (`E721`) are the newest arms in both engines; every
  other mechanically-fixable check (formatting, dead code, deprecations)
  is one more switch arm in `src/propose.ts`.
- **A live Langfuse dashboard.** The tracer and audit are proven end-to-end
  against the local mock with real SDK calls; pointing them at a real
  project is the remaining gap.
- **This is not a product.** No accounts, no hosting. It runs from a command
  line, or as a skill inside any agent that reads `skills/kintsugi/`.

Watch mode is not on this list — it exists. `run-loop.sh --watch` keeps the
loop resident (polling in the Python engine, file-watching in the Node
engine), re-running a pass a couple of seconds after each change settles and
ignoring its own writes so a repair never re-triggers itself.
