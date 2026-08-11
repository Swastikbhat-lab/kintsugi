"""Kintsugi Python engine: check runner + repair rules with no Node runtime.

This is the Python port of the engine's check runner and repair rules. It is
a faithful port of the TypeScript engine for the non-Node path (Python and Go
repos): same strict parser contract, same repair rules, same verify gate,
same ledger format, same report shape. The TypeScript engine remains the
full orchestrator (agent graph, watch mode, model proposer); this package
covers discover -> run -> parse -> propose -> apply -> verify -> commit
entirely under Python.
"""

__version__ = "0.2.0"
