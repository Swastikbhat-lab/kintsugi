# Keyless Langfuse demo

Prove the tracer → trace → audit pipeline without a Langfuse account.
`langfuse_mock.py` implements exactly the two HTTP endpoints the real
SDKs call — `POST /api/public/ingestion` and
`GET /api/public/observations` — so the **real** `langfuse` SDK posts
real traces to it, and `kintsugi --trace` reads them back.

```
# 1. Start the mock (stdlib only)
python demo/langfuse_mock.py 8787

# 2. Run the loop against the defective fixture, keys pointed at the mock
#    (any key values work — the mock ignores auth)
LANGFUSE_PUBLIC_KEY=pk-lf-demo LANGFUSE_SECRET_KEY=sk-lf-demo \
LANGFUSE_HOST=http://127.0.0.1:8787 \
python -m kintsugi --source demo/fixture --llm-mock demo/proposals.json --budget 3

# 3. Audit the newest trace
kintsugi --trace <traceId>   # with the same LANGFUSE_* env

# 4. Open the observability dashboard (runs list, timeline, cost tables)
open http://127.0.0.1:8787/
```

The dashboard (`/`) lists every traced run with its status and cost, and
drills into each trace: stat cards (cost, tokens, model calls, attempts),
a phase timeline (observe → propose → verify → settle) with expandable
payloads, the ledger-joined attempts table, and the per-finding cost
table with input/output token bars. Deep-link any trace at
`/?trace=<traceId>`.

The fixture (`demo/fixture/src/tax.py`) is **deliberately broken** —
`apply_tax` ignores its rate so `assert apply_tax(100) == 10` fails.
The loop finds it, the mock proposes the fix with real token usage
(1500 in / 700 out), the verify gate commits it, and the trace carries
the whole ledger story: an `observe` span per check, a `propose`
generation with the reported usage, a `verify` span mirroring the
ledger attempt, and a `settle` span with the full attempt history.
The audit table then shows `committed · 1500/700 · $0.025000`.

Run it again? Restore the defect first
(`git checkout -- demo/fixture/src/tax.py`) and clear the ledger
(`rm ~/.kintsugi/ledgers/<hash>.json` — the hash is `sha1` of the
absolute fixture path).

> The mock keeps its store in memory — restarting it clears all traces.
> The fixture lives inside the repo on purpose so the demo is
> self-contained; it is never picked up by the repo's own checks.
