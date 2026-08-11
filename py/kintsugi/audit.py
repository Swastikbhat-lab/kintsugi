"""Audit a finished run from its Langfuse trace.

The tracer mirrors the ledger's structure: a final `settle` span carries
the full attempt history (fingerprint, outcome, patch, provider,
collateral, at), and each model call is a `generation` observation
carrying the usage the provider actually reported plus the fingerprint it
was made for. This module joins the two — the same join the ledger would
let you do locally — and prints a per-finding table:

    FINGERPRINT   FINDING                OUTCOME        IN   OUT  COST
    3069a1162608  py:test (assert)       committed      0    0    $0.000000

Usage:

    kintsugi --trace <traceId>            # py engine
    npm run cli -- --trace <traceId>      # ts engine

Requires LANGFUSE_PUBLIC_KEY/SECRET_KEY (the read side is a separate
client from the tracer; it does not need the SDK's tracing queue). With
no keys, or no `langfuse` SDK, it prints a clear message and exits 2 —
auditing is optional, never load-bearing.
"""

import os


def _record_fields(record) -> dict:
    """Normalize an ObservationV2 record into a plain dict, accepting the
    snake_case pydantic model or a raw dict from a mocked client."""
    if isinstance(record, dict):
        return record
    out = {}
    for key in ("id", "trace_id", "traceId", "name", "type", "input", "output",
                "metadata", "usage", "start_time", "startTime"):
        if hasattr(record, key):
            out[key] = getattr(record, key)
    return out


def _as_dict(value) -> dict:
    if isinstance(value, dict):
        return value
    if value is None:
        return {}
    # pydantic models expose model_dump / dict()
    for m in ("model_dump", "dict"):
        f = getattr(value, m, None)
        if callable(f):
            try:
                return f()
            except Exception:
                pass
    return {}


def audit_trace(client, trace_id: str) -> dict:
    """Query one trace's observations, join generation usage to the settle
    span's attempts by fingerprint, and return the table data.

    Returns:
        {"status": "ok", "rows": [...], "total": {...}}
        or {"status": "no-trace"} when the trace holds no kintsugi settle span.
    """
    try:
        obs = client.api.observations.get_many(
            trace_id=trace_id,
            limit=1000,
            fields="core,basic,usage",
        )
    except Exception:
        return {"status": "error", "message": "failed to query Langfuse observations"}

    records = getattr(obs, "data", None)
    if records is None and isinstance(obs, dict):
        records = obs.get("data") or []
    if not records:
        return {"status": "no-trace", "message": f"trace {trace_id} has no observations"}

    settle = None
    generations = []
    for raw in records:
        rec = _record_fields(raw)
        name = rec.get("name") or ""
        rtype = (rec.get("type") or "").upper()
        if name == "settle":
            settle = rec
        elif rtype == "GENERATION" or name == "propose":
            generations.append(rec)

    attempts = []
    if settle is not None:
        input_ = _as_dict(settle.get("input"))
        attempts = input_.get("attempts") or []

    # Join: fingerprint → (inputTokens, outputTokens). Generations carry the
    # fingerprint they were made for, so multiple model calls for one finding
    # accumulate into that finding's row.
    usage_by_fp = {}
    for g in generations:
        input_ = _as_dict(g.get("input"))
        fp = input_.get("fingerprint")
        usage = _as_dict(g.get("usage")) or {}
        if not fp:
            continue
        tokens = usage_by_fp.setdefault(fp, {"input": 0, "output": 0})
        tokens["input"] += int(usage.get("input") or 0)
        tokens["output"] += int(usage.get("output") or 0)

    rows = []
    for a in attempts:
        fp = a.get("fingerprint") or ""
        tokens = usage_by_fp.get(fp, {"input": 0, "output": 0})
        patch = _as_dict(a.get("patch")) or {}
        finding = f"{a.get('check', '')} ({patch.get('rationale') or ''})".strip() \
            or a.get("check", "")
        rows.append({
            "fingerprint": fp,
            "finding": finding[:64],
            "outcome": a.get("outcome") or "",
            "provider": bool(a.get("provider")),
            "inputTokens": tokens["input"],
            "outputTokens": tokens["output"],
        })

    rows.sort(key=lambda r: r["inputTokens"] + r["outputTokens"], reverse=True)
    total = {
        "input": sum(r["inputTokens"] for r in rows),
        "output": sum(r["outputTokens"] for r in rows),
    }
    return {"status": "ok", "rows": rows, "total": total}


def print_audit(result: dict, cost_usd) -> str:
    """Render the audit result as a table. cost_usd(input, output) is
    injected so pricing stays consistent with the tracer."""
    if result.get("status") == "no-trace":
        return result.get("message", "no trace")
    if result.get("status") == "error":
        return result.get("message", "query failed")
    rows = result["rows"]
    if not rows:
        return "Trace has no kintsugi attempt history (no repairs attempted)."
    lines = [
        f"{'FINGERPRINT':<14} {'FINDING':<46} {'OUTCOME':<12} {'IN':>6} {'OUT':>6} {'COST':>10}",
        "-" * 96,
    ]
    for r in rows:
        cost = cost_usd(r["inputTokens"], r["outputTokens"])
        lines.append(
            f"{r['fingerprint']:<14} {r['finding'][:46]:<46} {r['outcome'][:12]:<12} "
            f"{r['inputTokens']:>6} {r['outputTokens']:>6} {cost:>10.6f}"
        )
    lines.append("-" * 96)
    t = result["total"]
    lines.append(
        f"{'TOTAL':<14} {'':<46} {'':<12} {t['input']:>6} {t['output']:>6} "
        f"{cost_usd(t['input'], t['output']):>10.6f}"
    )
    return "\n".join(lines)


def create_audit_client():
    """A read-only Langfuse client from env keys — or None when the SDK or
    keys are missing. Independent of the tracer, so auditing a run that was
    traced earlier (possibly from another machine) works the same way."""
    if not (os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")):
        return None
    try:
        from langfuse import Langfuse

        return Langfuse(
            public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
            secret_key=os.environ["LANGFUSE_SECRET_KEY"],
            host=os.environ.get("LANGFUSE_HOST", "https://cloud.langfuse.com"),
        )
    except Exception:
        return None
