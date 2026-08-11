#!/usr/bin/env python
"""Untested-function detector — the `py:testgen` check.

Emits one strict line per top-level public function whose module has no
sibling test file at all (`test_<stem>.py` or `<stem>_test.py`), so the
repair rule and this detector always agree on what "no tests" means:

    src/tax.py:3: T001 function 'apply_tax' has no tests

The repair rule for T001 then generates a smoke test file next to the
module and lets the verify gate run it.

    python testgen_detect.py <source-root>

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
_TEST_FILE = re.compile(r"(?:^|[/\\])test_[^/\\]*\.py$|(?:^|[/\\])[^/\\]*_test\.py$")


def top_level_funcs(path: str):
    """(name, lineno) for every top-level public function in a module."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            tree = ast.parse(fh.read())
    except (OSError, SyntaxError):
        return []
    out = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name.startswith("_"):
                continue
            out.append((node.name, node.lineno))
    return out


def has_sibling_test(module_path: str) -> bool:
    d = os.path.dirname(module_path)
    stem = os.path.splitext(os.path.basename(module_path))[0]
    return os.path.exists(os.path.join(d, f"test_{stem}.py")) or os.path.exists(
        os.path.join(d, f"{stem}_test.py")
    )


def main(argv):
    root = os.path.abspath(argv[1] if len(argv) > 1 else ".")
    findings = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames
            if not _SKIP.search(os.path.relpath(os.path.join(dirpath, d), root).replace("\\", "/"))
        ]
        for fn in filenames:
            if not fn.endswith(".py") or fn == "__init__.py":
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            if _SKIP.search(rel) or _TEST_FILE.search(rel):
                continue
            if has_sibling_test(full):
                continue
            for name, lineno in top_level_funcs(full):
                findings.append(f"{rel}:{lineno}: T001 function '{name}' has no tests")
    if findings:
        sys.stdout.write("\n".join(findings) + "\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
