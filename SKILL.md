---
name: Kintsugi
description: Self-healing code repair tool — finds defects in any codebase by running configurable checks (typecheck, lint, tests, custom scripts), then repairs the ones with an objectively correct fix and re-checks to confirm. Use when you need to fix type errors, lint violations, import issues, version drift, or custom check failures across a codebase — e.g., fixing TS6133 (unused declarations) or TS2307 (missing imports), or running a post-refactor audit. Triggered by the user mentioning "kintsugi", "auto-fix", "heal", "fix type errors", or "repair".
vibe: Observe → Diagnose → Repair → Verify → Settle. Every patch is verified before it ships.
---

# Kintsugi — Self-Healing Code Repair

Kintsugi finds defects in a codebase, repairs the ones that have an objectively correct fix, and re-checks to confirm the repair worked. Anything it cannot verify, it reverts.

## How to run it

The tool lives at `./kintsugi/` (relative to the workspace root). It works with any codebase: point it at a source directory and a list of check commands.

### Quick audit (survey only, writes nothing)

```bash
cd kintsugi && npx tsx src/cli.ts --target . --source <repo-path> --checks checks.json --dry
```

### Full repair run

```bash
cd kintsugi && npx tsx src/cli.ts --target . --source <repo-path> --checks checks.json
```

### Continuous mode (watch on a cadence)

```bash
cd kintsugi && npx tsx src/cli.ts --target . --source <repo-path> --checks checks.json --watch 30
```

### Git mode (each verified fix on its own commit)

```bash
cd kintsugi && npx tsx src/cli.ts --target . --source <repo-path> --checks checks.json --git --branch kintsugi/fixes
```

## The checks file (checks.json)

This is the heart of Kintsugi — it tells the loop what to check and how to parse the output:

```json
{
  "checks": [
    { "name": "typecheck", "command": "npx tsc --noEmit", "parser": "tsc" },
    { "name": "lint", "command": "npx eslint . --format unix", "parser": "lines" },
    { "name": "version", "command": "node -e \"const p=require('./package.json');console.log(p.version === require('./README.md').split('v')[1].split(' ')[0]?'ok':'version mismatch')\"", "parser": "lines" }
  ],
  "budget": 3,
  "maxIterations": 8
}
```

### Supported parsers

| Parser | What it understands | Example command |
|---|---|---|
| `tsc` | TypeScript errors with file/line/column/code | `npx tsc --noEmit` |
| `tap` | TAP test output | `npx tap` |
| `lines` | Plain text, one finding per line | `grep "FIXME"` |

### Healers included (rules-first, model for the rest)

| Defect | Healer | Files modified |
|---|---|---|
| `TS6133` (unused declaration) | Removes the `const`/`let`/`var` line | 1 file |
| `TS2307` (cannot find module) | Points the import at the actual file | 1 file |
| `TS2305` (not exported) | Adds `export` to the declaration | 1 file |
| Version drift | Replaces the stale version string | 1 file |

### Model proposer (for everything rules can't reach)

Set `ANTHROPIC_API_KEY` in your environment for AI-assisted repairs. The model proposes fixes; the verify gate (re-running the check) decides whether they ship.

## The loop — the guarantee

```
Observe → Diagnose → Repair → Verify → Settle
```

Every repair passes through the **verify gate**: the check is re-run after the patch is applied. The patch is kept only if:
1. The target finding is gone
2. No new findings appeared (no collateral damage)

If either fails, the patch is reverted. The loop never ships an unverified change.

## What it will not do

- Heal a check that crashed (that's a broken harness, not a defect)
- Touch files outside the source root
- Apply a patch whose anchor string isn't found in the file
- Make changes to shared files (tokens, globals) without `--allow-tokens`
- Guess at things that need intent (console errors, overlapping elements, alt text)

## Ledger

Kintsugi remembers every repair attempt in `~/.kintsugi/ledgers/<key>.json`. A patch that was ineffective or caused regressions is never re-proposed. A finding with no untried candidates left is quarantined for a human.

## Examples

### Fix TypeScript errors across a project

```bash
cat > checks.json << 'EOF'
{
  "checks": [
    { "name": "tsc", "command": "npx tsc --noEmit", "parser": "tsc" }
  ],
  "budget": 3,
  "maxIterations": 5
}
EOF
cd kintsugi && npx tsx src/cli.ts --target . --source ../my-project --checks checks.json --dry
```

### Fix lint violations

```bash
cat > checks.json << 'EOF'
{
  "checks": [
    { "name": "eslint", "command": "npx eslint . --format unix", "parser": "lines" }
  ],
  "budget": 2,
  "maxIterations": 8
}
EOF
cd kintsugi && npx tsx src/cli.ts --target . --source ../my-project --checks checks.json
```

### Run Kintsugi on Kintsugi itself (self-healing)

```bash
cd kintsugi && npx tsx src/cli.ts --target . --source . --checks checks.json --dry
```

## Installation requirements

- Node.js >= 22
- `npm install` in the kintsugi directory (Playwright for browser-based checks)
- For model-assisted repairs: `ANTHROPIC_API_KEY` env var
- For git mode: the target repo must be a clean git tree
