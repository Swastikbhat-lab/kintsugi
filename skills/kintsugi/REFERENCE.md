# Reference

## Config (`kintsugi.config.json` in the target repo)

```jsonc
{
  "checks": [
    { "name": "typecheck", "command": "npm run typecheck", "parser": "tsc", "severity": "major" },
    { "name": "test", "command": "npm test", "parser": "tap", "severity": "blocker" },
    { "name": "version", "command": "npm run check:version", "parser": "lines", "severity": "minor" }
  ],
  "budget": 2,          // repair attempts per finding
  "maxIterations": 12,  // hard stop
  "allowShared": false  // escalate patches on shared files unless true
}
```

No config file? The engine detects the repo's toolchain and derives
defaults, gating each on a quick availability probe so a repo never gets a
check whose tool is missing:

- **npm** — `typecheck` (tsc) + `test` (tap) from `package.json` scripts
- **Python** — `py:test` (pytest `-q --tb=line`) + `py:lint` (ruff
  `--output-format=concise`), venv-aware (`.venv`/`venv` preferred)
- **Go** — `go:test` (`go test ./...`) + `go:vet` (`go vet ./...`)
- **Rust** — `rs:test` (`cargo test --quiet`) + `rs:lint` (`cargo clippy
  -- -D warnings`), each with a 300s timeout for cargo's cold builds
- **Mixed** repos get the union of their toolchains

`--list-checks` prints what would run. The kintsugi repo itself ships a
`kintsugi.config.json` pinning `--test-reporter=tap` so its own test check
speaks TAP on every platform.

### Parsers

| Parser | Reads | Example finding |
|---|---|---|
| `tsc` | `file(line,col): error TSxxxx: message` | `TS2307: Cannot find module './shipping-costs'` |
| `tap` | Node test-runner TAP | `not ok 2 - applyTax applies the 10% tax rate` |
| `spec` | Node test-runner spec output (`✔`/`✖`) | `✖ the loop repairs five defect classes (12774ms)` |
| `lines` | one `path: message` (or bare `message`) per line | `README.md: version 0.1.0 does not match 0.2.0` |
| `strict` | `path:line[:col]: message` only — bare lines are never findings | `src/foo.py:12:5: F401 'os' imported but unused` |
| `rust` | cargo test panic frames (`panicked at path:line:col:`), paired `warning:`/`error…:` + `--> path:line:col` diagnostics, and short-format lines | `warning: unused import: \`std::fmt\`` + `--> src/lib.rs:2:5` |

`strict` (and `rust`) are defensive beyond the shape: paths under
`node_modules`, `dist`, `build`, `.git`, `target` (cargo's build dir),
virtualenvs (`.venv`/`venv`/`site-packages`) and Python caches are never
findings, and pytest `warnings summary` lines (`path:line: XxxWarning: …`)
are ignored — a noisy suite must not surface phantom defects.

**Two engines, one loop.** The TypeScript engine (`src/`) is the
orchestrator (agent graph concurrency); the Python engine (`py/`,
`python -m kintsugi` from `py/`) is a faithful port for non-Node repos —
check runner, repair rules, verify gate, ledger, watch mode (polling-based,
`--watch`/`--interval`), and the model proposer (optional `anthropic` SDK,
or `--llm-mock <path>` for keyless runs). `run-loop.sh` auto-dispatches
Python-only repos to it — the Python path needs no Node runtime at all.
Both share the ledger format, report shape, and exit-code contract, and
run the same propose -> critics -> gate -> verify flow when a provider is
configured.

A check that exits non-zero with no parseable finding is a **crash** — the
loop reports it and never heals it. One exception is built in: if the
declared parser yields nothing but the output is clearly spec-shaped
(`✔`/`✖`), it is parsed as spec — a repo whose `npm test` omits the tap
reporter is a repo with failing tests, never a broken harness.

## Findings

```ts
{
  fingerprint: string,   // stable across runs; the ledger keys on this
  check: string,         // check name
  severity: 'blocker' | 'major' | 'minor',
  summary: string,
  file?: string,         // absolute path when known
  line?: number,
  code?: string,         // e.g. TS2307
  evidence: Record<string, unknown>  // parsed specifics for the healer
}
```

Fingerprints normalise numbers, so line numbers, counts and versions do not
reshuffle the ledger on every run.

## Patches

A patch is one exact string replacement: `{ file, find, replace }` plus a
rationale. Applied to the **first** occurrence only — an anchor that matches
in several places is ambiguous, and applying it everywhere is how one fix
quietly restyles half a codebase. Nothing is ever touched outside the source
root; a model-supplied path that resolves outside it is dropped.

Blast radius is computed from the import graph: `local` (≤1 importer) is
applied; `shared` (≥2 importers) is escalated with the count unless
`--allow-shared`.

## Ledger

Lives in `~/.kintsugi/ledgers/<hash>.json`, keyed by source root — never
inside the repo under audit. Every attempt is `fingerprint → patch →
outcome` (`committed | ineffective | regressed | unverifiable`) plus
`provider` (whether a model/mock was available). The loop tries committed
patch shapes first, never re-proposes a disproved shape, and quarantines a
finding with no untried candidates.

Only a **provider-backed** dead end is permanent: a rules-only run records
`patch.id === 'none'` for findings no mechanical rule reaches, which proves
nothing about what a model could propose — so a later run with a model
configured retries them instead of staying blind. Run keyless first, add a
model key later: nothing learned is lost, nothing provable is skipped.

## CLI

```bash
npm run cli -- --source <repo>            # full loop, rules-only
npm run cli -- --source <repo> --dry      # survey: report, write nothing
npm run cli -- --source <repo> --llm-mock proposals.json
npm run cli -- --source <repo> --allow-shared
npm run cli -- --source <repo> --quarantined-ok
npm run cli -- --source <repo> --git      # one commit per verified fix
npm run cli -- --source <repo> --json
```

Exit code: `0` when nothing actionable remains, `1` while defects remain —
so it can gate a pipeline. `--quarantined-ok` makes quarantine (a human
decision, not an unfixed bug) exit `0` too.

## Mock proposals (keyless demo of the LLM path)

```json
[
  {
    "match": { "check": "test", "contains": "applyTax" },
    "candidates": [
      { "file": "src/pricing.ts", "find": "return amount * 0.08;",
        "replace": "return amount * 0.05;", "rationale": "wrong guess — verify must reject" },
      { "file": "src/pricing.ts", "find": "return amount * 0.08;",
        "replace": "return amount * 0.10;", "rationale": "the test asserts 10%" }
    ]
  }
]
```

Candidates for the same finding are tried in order; a candidate the verify
gate disproves is recorded and never tried again — the loop learns from its
misses exactly as it would with a real model.
