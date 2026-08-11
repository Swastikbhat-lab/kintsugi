"""Kintsugi Python engine: check runner + repair rules with no Node runtime.

This is the Python port of the engine's check runner and repair rules. It is
a faithful port of the TypeScript engine for the non-Node path (Python and
Go repos): same strict parser contract, same repair rules, same verify gate,
same ledger format, same report shape, same exit codes. It also ports watch
mode (polling-based) and the model proposer (an optional `anthropic` SDK, or
`--llm-mock` for keyless runs), so the two engines' capability surfaces
match. It also carries the CodeGuardian harvest identically to the Node
engine: the py:bandit/py:radon/py:perf/py:best-practices/py:testgen checks,
the risk-scoring + suppression queue, the optional Langfuse tracer, and
test generation. The TypeScript engine additionally keeps the agent-graph
concurrency shape; the Python engine is its sequential core with the same
semantics.

    discover -> run -> parse -> propose (rules, then model) -> critics ->
    gate -> apply -> verify -> commit -> ledger

entirely under Python.
"""

__version__ = "0.2.0"
