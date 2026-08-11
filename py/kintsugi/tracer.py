"""Optional observability alongside the ledger — harvested from
CodeGuardian's Langfuse tracing, rebuilt on the one thing the old version
got wrong: *real* numbers. Token usage is captured from the model response,
never fabricated from a guess, and cost is derived from it.

The tracer is strictly optional and best-effort:

  - without LANGFUSE_PUBLIC_KEY/SECRET_KEY it is an inert object;
  - with keys but no `langfuse` SDK installed it is an inert object;
  - every SDK call is wrapped so a tracing failure can never take the
    repair loop down (telemetry must not be load-bearing).

This is a faithful mirror of the TypeScript engine's `src/tracer.ts`.
"""

import os
import uuid


def input_price() -> float:
    """Default list price (USD per 1M input tokens) — override via env."""
    return float(os.environ.get("KINTSUGI_INPUT_PRICE", "5"))


def output_price() -> float:
    return float(os.environ.get("KINTSUGI_OUTPUT_PRICE", "25"))


def cost_usd(input_tokens: int, output_tokens: int) -> float:
    """USD cost of a model call from its *reported* token usage."""
    return (input_tokens / 1_000_000) * input_price() + (output_tokens / 1_000_000) * output_price()


class Tracer:
    """One Langfuse trace per run; spans for each phase. Inert without keys."""

    def __init__(self, client=None):
        self.client = client
        self.trace_id = None

    @staticmethod
    def create():
        if not (os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")):
            return Tracer(None)
        try:
            from langfuse import Langfuse
            client = Langfuse(
                public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
                secret_key=os.environ["LANGFUSE_SECRET_KEY"],
                host=os.environ.get("LANGFUSE_HOST", "https://cloud.langfuse.com"),
            )
            return Tracer(client)
        except Exception:
            # SDK not installed — telemetry is optional.
            return Tracer(None)

    @property
    def active(self) -> bool:
        return self.client is not None

    def start_run(self, config: dict) -> None:
        if not self.client:
            return
        try:
            self.trace_id = uuid.uuid4().hex
            self.client.trace(
                id=self.trace_id,
                name="kintsugi",
                input={
                    "sourceRoot": config.get("sourceRoot"),
                    "checks": [c["name"] for c in config.get("checks", [])],
                    "budget": config.get("budget"),
                },
            )
        except Exception:
            self.trace_id = None

    def span(self, name: str, **data) -> None:
        """A duration-bearing phase of the loop (observe, verify, settle)."""
        if not self.client or not self.trace_id:
            return
        try:
            self.client.span(name=name, trace_id=self.trace_id, input=data)
        except Exception:
            pass  # best effort

    def generation(self, name: str, usage, **data) -> None:
        """A model call, with the usage it actually reported."""
        if not self.client or not self.trace_id or not usage:
            return
        try:
            input_tokens = int(usage.get("inputTokens") or 0)
            output_tokens = int(usage.get("outputTokens") or 0)
            self.client.generation(
                name=name,
                trace_id=self.trace_id,
                input=data,
                model="claude-opus-5",
                usage={"input": input_tokens, "output": output_tokens,
                       "total": input_tokens + output_tokens},
                metadata={"costUsd": cost_usd(input_tokens, output_tokens)},
            )
        except Exception:
            pass  # best effort

    def flush(self) -> None:
        if not self.client:
            return
        try:
            self.client.flush()
        except Exception:
            pass  # best effort
