# Research: is there already a self-healing-loop skill?

Decision that shaped this project, recorded so it does not have to be
re-derived.

## What a Claude skill is

Agent Skills (Anthropic, Oct 2025) are filesystem-based capabilities: a
directory with a `SKILL.md` whose YAML frontmatter (`name`, `description`)
is always loaded, whose body loads when triggered, and whose bundled
scripts/resources load only when referenced. That is the whole progressive-
disclosure design: ~100 tokens per installed skill until it is relevant, the
body under ~5k tokens when it is, and executable code that never enters
context at all. Skills live in `~/.claude/skills/` (personal) or
`.claude/skills/` (project) for Claude Code.

Kintsugi already had the shape of a skill before it was one — a directory of
instructions (`README.md`, `OVERVIEW.md`) plus a deterministic engine
(`src/`) with an optional model seam. The pivot makes the shape explicit.

## What exists on GitHub (surveyed Aug 11, 2026)

Searched the top Claude-skill collections (`awesome-claude-skills`,
`claude-skills` registries, skill registries) and code search for
self-healing/repair-loop skills:

- **`ramsbaby/openclaw-self-healing`** — a 4-tier self-healing system for the
  *OpenClaw Gateway* specifically: keeps one daemon alive. Domain-locked.
- **`nrwl/nx-ai-agents-config` (monitor-ci skill)** — watches Nx Cloud CI and
  applies self-healing fixes to CI workflows. Domain-locked to Nx CI.
- **`xenitV1/claude-code-maestro`** — a routing skill whose debug path
  mentions a "self-healing iteration loop"; it is a mention inside a larger
  prompt framework, not a packaged loop.
- **`azadmotala/claude-code-team-builder`** — builds agent teams whose
  problem-solver role is told to "self-heal" tasks. Instructions to an
  agent, not a verify-gated loop.
- **`lodekeeper/dotfiles` (log-reader)** — tells itself to keep its own docs
  accurate ("skills should stay accurate and self-healing"). Doc hygiene.

Common threads across every hit: they are **domain-locked** (one gateway,
one CI product), or **advisory** (prompt the agent to be careful), or both.
None packages the full **observe → diagnose → repair → verify → settle**
loop — with a mechanical verify gate, a ledger against dead ends, and a
blast-radius rule that refuses to touch shared code — as a transferable
skill for any codebase defect.

## The gap

A verify-gated repair loop is precisely the part naive auto-fixers skip, and
it is the part that makes them safe to run unattended. The closest things on
GitHub are domain-specific healers that re-run *their own* check, and prompt
frameworks that tell an agent to be careful. Kintsugi generalizes the loop
itself: any check command becomes an observation source, any exact-string
edit becomes a repair, and the verify gate stays mechanical regardless of
domain.

## The decision

Build the skill. The repo pivots from "self-healing UI" to "the
self-healing loop, generalized", packaged as a Claude skill under
`skills/kintsugi/` with the engine as its reference implementation. The
UI/UX detectors are dropped; the loop, the ledger, the blast-radius rule and
the multi-agent graph survive unchanged in spirit.
