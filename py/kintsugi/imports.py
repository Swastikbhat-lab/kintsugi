"""A rough Python import graph, built by scanning statements rather than
parsing.

Its only job is blast radius: how many modules would a change to this file
reach? It never needs to be exact — a heuristic that overcounts importers
escalates a few extra files, and undercounting is the risk, so it errs
toward treating a file as shared. This is the Python half of the TS engine's
imports.ts (TS/JS scanning stays with the Node engine).
"""

import glob
import os
import re

SKIP = re.compile(r"(^|[\\/])(node_modules|dist|build|\.git)([\\/]|$)")
PY_IMPORT_RE = re.compile(r"^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))", re.MULTILINE)
# Test files are not product importers — they exercise the code, not own it.
TEST_FILE = re.compile(r"(?:^|[/\\])(?:test_|_test)\.py$")


def build_import_graph(source_root: str):
    importers = {}
    deps = {}
    files = []
    for f in glob.glob(os.path.join(source_root, "**", "*.py"), recursive=True):
        rel = os.path.relpath(f, source_root).replace("\\", "/")
        if SKIP.search(rel):
            continue
        files.append(f)
    file_set = set(files)

    for file in files:
        with open(file, "r", encoding="utf-8", errors="replace", newline="") as fh:
            text = fh.read()
        targets = set()
        for m in PY_IMPORT_RE.finditer(text):
            spec = (m.group(1) or m.group(2) or "").strip()
            if not spec:
                continue
            target = _resolve_spec(spec, file, source_root, file_set)
            if target:
                targets.add(target)
        deps[file] = targets
        # A file imported by a *test* is not a shared product module — tests
        # reference modules they exercise, and editing those modules is
        # normal. Only product-code importers count toward blast radius.
        if TEST_FILE.search(file):
            continue
        for t in targets:
            importers.setdefault(t, set()).add(file)

    return {"importers": importers, "deps": deps, "files": files}


def _resolve_spec(spec: str, file: str, source_root: str, file_set: set) -> str | None:
    if spec.startswith("."):
        dots = len(re.match(r"^\.+", spec).group(0))
        rest = spec[dots:]
        parts = [".."] * (dots - 1) + ([rest] if rest else [""])
        base = os.path.normpath(os.path.join(os.path.dirname(file), *parts))
        candidates = [f"{base}.py", os.path.join(base, "__init__.py")]
    else:
        base = os.path.join(source_root, *spec.split("."))
        candidates = [os.path.join(base, "__init__.py")]
    for cand in candidates:
        if cand in file_set:
            return cand
    return None


def scope_of(graph, file: str):
    """Blast radius from the shape of the graph, not from the patch. A file
    imported by two or more modules is shared: editing it moves code the loop
    was not looking at, so the repair is escalated instead of applied."""
    n = len(graph["importers"].get(file, set()))
    return ("shared" if n >= 2 else "local"), n
