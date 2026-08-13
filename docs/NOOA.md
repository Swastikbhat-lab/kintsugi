# NOOA and what Kintsugi took from it

> **What this is.** [NOOA](https://github.com/NVIDIA-NeMo/labs-OO-Agents) —
> NVIDIA Object-Oriented Agents (arXiv:2607.20709) — is a model-agnostic
> Python framework for building AI agents, open-sourced in July 2026. Its
> thesis: *an agent is a Python object*. Methods are the actions the model
> can take, fields are state, docstrings are prompts, type annotations are
> contracts, and a method whose body is `...` is completed at runtime by an
> LLM loop while a method with a real body stays deterministic Python.
>
> Kintsugi does not depend on NOOA. We studied its design, mapped its six
> capabilities against our engine, and took the two that fit — and
> deliberately refused the two that don't. This document is the record of
> that decision, so the borrowings stay attributable and the refusals stay
> reasoned.

## The six capabilities, and how Kintsugi measured up

| NOOA capability | Kintsugi before | Verdict |
|---|---|---|
| Typed I/O with auto-retry | JSON schemas + drop-on-invalid, **no retry** | **Partial → took it** |
| Pass-by-reference over live objects | model sees serialized text only | **Absent → refused the mechanism** |
| Code as action (LLM writes Python that runs) | LLM emits text; only deterministic engine code executes | **Absent → refused** |
| Programmable loop engineering | configurable `Loop`, fixed topology | **Partial** |
| Explicit object state | `Loop.state` + the **Ledger** (cross-run memory) | **Implemented — we lead** |
| Model-callable harness APIs (context, events) | rich tracing/audit, but nothing model-callable | **Absent → took the context half** |

## What we took, and where it landed

### 1. Typed I/O with auto-retry — `py/kintsugi/provider.py`, `src/provider.ts`

**The idea.** NOOA retries a method whose return value breaks its declared
contract instead of letting a malformed reply silently become "the model had
nothing to say". We applied it to our model seam: a reply that breaks the
output contract is the model's fault, not the harness's.

**What changed.**
- `ClaudeProvider._call` now retries (bounded, 2 attempts) when the model
  returns no text block or non-JSON text despite a schema. API/transport
  errors are **never** retried — a broken credential is not a signal to
  spend more money. The error type is `_ContractViolation` (Python) /
  `ContractViolation` (TS), a `RuntimeError` so old callers' exception
  contract holds.
- Token usage is **accumulated across retries**, so the tracer and audit
  log charge a retried call what its retries actually cost.
- When every proposed patch breaks the one rule the harness can *prove* —
  the `find` anchor must exist verbatim in the file — we do **one
  corrective re-prompt** naming the rejected anchors, instead of quietly
  recording a dead end.
- An empty patch list is still a real answer. Retries are for contract
  violations, not for taste; an honest abstention costs exactly one call.

**Tests:** `py/tests/test_provider.py` — retry on malformed JSON, usage
accumulation, give-up after budget, corrective retry on anchor mismatch,
empty-list-not-retried.

### 2. Model-callable context — `py/kintsugi/loop.py` + `provider.py`, `src/loop.ts` + `provider.ts`

**The idea.** The safe half of NOOA's pass-by-reference: the model sees what
the harness already knows, without ever being able to touch it.

**What changed.** The loop now computes the import graph *before* the model
is consulted and hands the proposer a `context` argument rendered into its
prompt:
- the **ledger's prior attempts** at this exact fingerprint (outcome +
  find → replace), so the model does not rediscover dead ends it already
  proved;
- the **importer count** when the target file is shared, so blast radius
  shapes the proposal instead of being decided after it.

Context enters **through the prompt** — declared, inspectable, bounded. The
model still cannot touch a live object or run code.

**Declared read-only tools** — `py/kintsugi/tools.py` + `src/tools.ts`.
Context alone is static; the model can now *ask* for more, through three
tools the harness executes: `read_file` (a file, optionally a line range),
`grep` (a regex, optionally under one path), and `importers` (who imports a
file — the same graph the loop already built for blast radius). A reply of
`{"tool": {"name": ..., "args": {...}}, "patches": []}` is executed by
engine code, never by the model, and the result returns as bounded text in
the next prompt. At most 6 tool calls per finding, every result capped by
the runner, paths refused when they escape the source root — a tool can
only *look*. This is NOOA's pass-by-reference effect (navigation) through
declared tools instead of live references or code execution.

**Tests:** `py/tests/test_provider.py` + `test/provider.test.ts` — the three
tools against a real repo, path containment, the bounded tool loop, an
unknown tool reported back to the model, context rendered into the prompt,
absent when no context, mock accepts the new signature.

## What we refused, and why

- **Code as action.** NOOA's model writes Python that executes in a REPL.
  We will not do this. Kintsugi's entire trust model is that the model
  *proposes text* and deterministic engine code applies and verifies it.
  NOOA's own README concedes its in-process guards are not a containment
  boundary and OS-level isolation is required. For a tool whose job is
  editing a repo you care about, executing LLM-generated Python against it
  is the worst possible primitive — the verify gate cannot attribute a
  patch the model half-wrote itself.
- **Live-object pass-by-reference.** Passing real objects to the model buys
  navigation power at the price of the model being able to mutate state the
  harness depends on. We took the *effect* (context navigation) instead of
  the *mechanism* (live references): context arrives as rendered text, and
  when the model needs to look further it calls declared read-only tools
  (read_file, grep, importers) that the harness executes — results come
  back as bounded text, paths cannot escape the source root, and nothing
  the model says can touch a live object. That is navigation without reach.

## Where Kintsugi already led

- **Explicit state / long-term memory.** The Ledger is cross-run,
  persistent memory keyed by fingerprint, where a patch shape that regressed
  is never retried and a proven shape jumps the queue. NOOA's `MemoryManager`
  is an optional extra; ours is load-bearing.
- **Loop engineering.** The verify gate — apply, re-run the checks, keep
  only if the finding is gone *and* nothing new appeared — is the phase
  NOOA's harness does not have, and it is the reason every borrowing above
  is safe to make: a bad proposal costs one reverted patch and one ledger
  entry, because something that cannot be argued with checks it afterwards.

## The principle

**Borrow effects, not mechanisms.** NOOA is a useful spec for what a model
seam could be — typed contracts with retry, harness memory exposed to the
model. Its most distinctive mechanisms (code execution, live references)
are precisely the ones that break a verify-gate trust model. We took the
ideas that strengthen the loop and left the ones that would weaken it.

*Context for this document: initial capability map and comparison live in
the conversation history that produced these changes; the changes themselves
are the two bullets above, mirrored across both engines with tests.*
