#!/usr/bin/env python
"""Best-practices scanner — the Python engine's own `py:best-practices`
check, ported from CodeGuardian's best-practices agent into the strict-line
contract (one `path:line: CODE message` per finding, exit 1 when any exist).

The mechanical trio (T201/T202/T203) has exact repair rules in the engine
proposer; the advisory pair (T101/T102) is surfaced for a human — or the
model proposer when one is configured.

    python lint_best.py <source-root>

Stdlib only — no third-party tools, so the check is always on for Python
repos.
"""

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

# (regex, code, message). T2xx are mechanically fixable — the proposer has
# exact rules for each; T1xx are advisory (they need intent).
_PATTERNS = [
    (re.compile(r"\b(?:TODO|FIXME|XXX)\b"), "T101", "TODO/FIXME comment found"),
    (re.compile(r"\bprint\s*\("), "T102", "use logging instead of print"),
    (re.compile(r"\btype\s*\(([^)]*)\)\s*(?:==|is)\s+(?!type\s*\()[A-Za-z_][\w.]*"),
     "T201", "use isinstance() instead of type()=="),
    (re.compile(r"\blen\s*\(\w+\)\s*(?:==\s*0|!=\s*0|>\s*0)\b"),
     "T202", "use truthiness instead of a len() comparison"),
    (re.compile(r"(?:'[^']*'|\"[^\"]*\"|\w+)\s+in\s+\w+\.keys\(\)"),
     "T203", "use 'in d' instead of 'in d.keys()'"),
]


def scan_file(path: str, rel: str):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().split("\n")
    except OSError:
        return []
    out = []
    for i, line in enumerate(lines, 1):
        for rx, code, message in _PATTERNS:
            if rx.search(line):
                out.append(f"{rel}:{i}: {code} {message}")
                # One code per line, in pattern order; a line that hits
                # several is rare and the first is the most specific.
                break
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
