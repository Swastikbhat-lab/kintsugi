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
# exact rules for each; T1xx are advisory (they need intent). T105 is the
# hardcoded-secret class, detected separately in scan_file: bandit's B105
# misses API_KEY-style names, so the engine's own scanner catches the gap —
# but only when the value *looks* like a secret (a vendor prefix such as
# sk-/AKIA/ghp_, or a long mixed-case/digit/punct run with no spaces).
# CACHE_KEY = "cart" stays alone; API_KEY = "sk-live-3f9a2c…" does not.
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

# Secret-looking values: vendor prefixes (OpenAI sk-, AWS AKIA, GitHub
# ghp_/gho_/ghu_/ghs_/ghr_, JWTs eyJ…, Slack xox…), or any long run of
# mixed-case letters, digits, and underscores/hyphens (entropy suggests a
# key, not a word). Values with spaces are never secrets.
_T105_VALUE = re.compile(
    r"(?:sk-[A-Za-z0-9_\-]{10,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"eyJ[A-Za-z0-9_\-]{10,}\.|xox[baprs]-[A-Za-z0-9\-]{10,}|"
    r"(?=[A-Za-z0-9_\-]{20,}$)(?=[^a-z]*[A-Z0-9])[A-Za-z0-9_\-]{20,})"
)

# `NAME = "value"` assignments whose NAME smells like a credential
# (KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL/AUTH) — the smell is checked only
# after the value has already matched _T105_VALUE, so a benign CACHE_KEY is
# never touched.
_T105_ASSIGN = re.compile(
    r"^[ \t]*([A-Za-z_][\w]*)\s*=\s*(['\"])(.*?)\2\s*(?:#.*)?$"
)
_T105_NAME = re.compile(r"(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)")


def scan_file(path: str, rel: str):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().split("\n")
    except OSError:
        return []
    out = []
    for i, line in enumerate(lines, 1):
        # Hardcoded-secret check first (most specific): NAME = "<secret>".
        m = _T105_ASSIGN.match(line)
        if m and _T105_NAME.search(m.group(1)) and _T105_VALUE.search(m.group(3)):
            out.append(f"{rel}:{i}: T105 hardcoded secret in assignment to {m.group(1)}")
            continue
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
