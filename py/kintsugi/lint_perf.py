#!/usr/bin/env python
"""Performance-anti-pattern scanner — the Python engine's own `py:perf`
check, ported from CodeGuardian's performance agent into the strict-line
contract (one `path:line: CODE message` per finding, exit 1 when any exist).

Detection is AST-based (not line regex), so a call only counts when it
genuinely sits inside a loop body — the iterable of a `for` is executed
once and never flagged. None of these have a safe mechanical edit (the fix
is restructuring), so they surface for a human or the model proposer.

    python lint_perf.py <source-root>

Stdlib only.
"""

import ast
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

_SKIP = re.compile(
    r"(^|[\\/])(node_modules|dist|build|\.git|\.venv|venv|site-packages|"
    r"dist-packages|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|"
    r"\.tox|target)([\\/]|$)"
)


def _call_name(node):
    """A call's canonical name for the patterns we care about, else None."""
    f = node.func
    if isinstance(f, ast.Attribute):
        base = f.value
        if isinstance(base, ast.Name):
            if f.attr == "compile" and base.id == "re":
                return "re.compile"
            if f.attr == "append":
                return "list.append"
            if f.attr == "sleep" and base.id == "time":
                return "time.sleep"
    return None


def scan_file(path: str, rel: str):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            source = fh.read()
        tree = ast.parse(source)
    except (OSError, SyntaxError):
        return []

    out = []
    seen = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.For, ast.While)):
            continue
        for child in ast.walk(node):
            if not isinstance(child, ast.Call):
                continue
            name = _call_name(child)
            if not name:
                continue
            if (child.lineno, name) in seen:
                continue
            seen.add((child.lineno, name))
            message = {
                "re.compile": "regex compiled inside a loop — hoist it above the loop",
                "list.append": "list built with .append() inside a loop — a comprehension is faster",
                "time.sleep": "blocking sleep inside a loop",
            }[name]
            out.append(f"{rel}:{child.lineno}: P{101 if name == 're.compile' else 103 if name == 'list.append' else 104} {message}")
    return out


def main(argv):
    root = os.path.abspath(argv[1] if len(argv) > 1 else ".")
    findings = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames
            if not _SKIP.search(os.path.relpath(os.path.join(dirpath, d), root).replace("\\", "/"))
        ]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            if _SKIP.search(rel):
                continue
            findings.extend(scan_file(full, rel))
    if findings:
        sys.stdout.write("\n".join(findings) + "\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
