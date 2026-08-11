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

No config file? The engine derives defaults from the repo's own
`package.json` scripts: `typecheck` (tsc parser) and `test` (tap parser), if
they exist. Zero-config for an npm repo.

### Parsers

| Parser | Reads | Example finding |
|---|---|---|
| `tsc` | `file(line,col): error TSxxxx: message` | `TS2307: Cannot find module './shipping-costs'` |
| `tap` | Node test-runner TAP | `not ok 2 - applyTax applies the 10% tax rate` |
| `lines` | one `path: message` (or bare `message`) per line | `README.md: version 0.1.0 does not match 0.2.0` |

A check that exits non-zero with no parseable finding is a **crash** — the
loop reports it and never heals it.

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
outcome` (`committed | ineffective | regressed | unverifiable`). The loop
tries committed patch shapes first, never re-proposes a disproved shape, and
quarantines a finding with no untried candidates.

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
