"""Local audit trail — one NDJSON line per ledger attempt, no Langfuse.

The Langfuse tracer mirrors the ledger, but auditing then depends on an
external service and a query round-trip. This module gives the loop the
same story as a flat file: one structured JSON line per attempt
(fingerprint, outcome, check/code, patch rationale, provider, and the
token usage + derived cost of the model calls made for that finding),
plus a final summary line with the run totals. Read it with any JSONL
tool, or `jq -s` it into a table:

    jq -s '.[] | select(.event == "attempt") | [.fingerprint, .outcome, .costUsd]' audit.jsonl

Gated by --audit-log <path> on both CLIs; without the flag it is a
no-op and adds nothing to normal output.
"""

import json
import os
import sys
import time


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class AuditLog:
    """Best-effort NDJSON writer. Never raises; a bad path only stderr-notes."""

    def __init__(self, path: str | None, cost_usd):
        self.path = path
        self._cost = cost_usd
        self._fh = None
        self._failed = False
        if path:
            try:
                os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
                self._fh = open(path, "a", encoding="utf-8")
            except OSError as err:
                print(f"kintsugi: audit log unavailable ({err})", file=sys.stderr)
                self._failed = True

    @property
    def active(self) -> bool:
        return self._fh is not None

    def close(self) -> None:
        if self._fh:
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None

    def _write(self, record: dict) -> None:
        if not self._fh or self._failed:
            return
        try:
            self._fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            self._fh.flush()
        except (OSError, ValueError):
            # One bad record must not take the run down — drop the stream
            # so the failure is loud once, not on every line.
            self._failed = True
            try:
                self.close()
            except Exception:
                pass

    def attempt(self, *, fingerprint: str, outcome: str, check: str = "", code: str = "",
                rationale: str = "", provider: bool = False, collateral: list = None,
                input_tokens: int = 0, output_tokens: int = 0, run_id: str = "") -> None:
        self._write({
            "event": "attempt",
            "runId": run_id,
            "at": _iso_now(),
            "fingerprint": fingerprint,
            "outcome": outcome,
            "check": check,
            "code": code,
            "patchRationale": rationale,
            "provider": provider,
            "collateral": collateral or [],
            "usage": {"input": input_tokens, "output": output_tokens},
            "costUsd": self._cost(input_tokens, output_tokens),
        })

    def summary(self, *, run_id: str = "", status: str = "", iterations: int = 0,
                committed: int = 0, reverted: int = 0, quarantined: int = 0,
                total_input: int = 0, total_output: int = 0) -> None:
        self._write({
            "event": "summary",
            "runId": run_id,
            "at": _iso_now(),
            "status": status,
            "iterations": iterations,
            "committed": committed,
            "reverted": reverted,
            "quarantined": quarantined,
            "usage": {"input": total_input, "output": total_output},
            "costUsd": self._cost(total_input, total_output),
        })
