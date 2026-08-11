# The work graph: many agents, one serial tail

Each iteration of the loop deploys a small fleet of agents. A node is one
unit of work with one defined input and one defined output; an edge is a
genuine dependency — the next node consumes what the previous one produced.
Anything without an incoming edge starts immediately.

The roles — observer, healer, critic, verifier — ship as Claude Code
subagents (`.claude/agents/kintsugi-*.md`, also installed user-wide) so the
graph can be driven by hand; the engine runs the same graph in-process.

```
observe(test)  observe(typecheck)  observe(lint)  ← independent → concurrent
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
                   verify                            ← apply, re-run checks, decide
```

## The rules the shape enforces

**Every node declares its output contract.** A result that does not match is
rejected and retried rather than passed downstream, so a malformed result
fails where it was produced instead of corrupting whatever consumes it.

**The tail is serial, and must stay that way.** Repair and verify cannot run
concurrently: two patches applied at once destroy the verify step's ability
to say which one caused what. That edge is a real dependency, not a leftover
from writing the steps in order.

**Critics get fresh context.** The three critic agents judge the patch from
three angles — does it fix the defect, could it reach beyond it, is the
anchor unique — with no knowledge of who proposed it or why. A checker that
reads the proposer's reasoning is agreeing with it, not checking it. Their
verdicts are advisory; the gate that actually decides is the re-run of the
checks.

## What the concurrency buys

Observation is the expensive phase — one process per check, all running at
once. The gate's fan-in waits only for the slowest observer, which is the
only unavoidable wait. On a repo with ten checks, the loop pays for the
slowest one, not the sum.
