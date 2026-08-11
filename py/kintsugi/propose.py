"""Turning a finding into concrete candidate edits against real source files.

Every patch is an exact string replacement anchored on text that is known to
exist in the file. Rules exist for the defect classes with an *objectively
correct* edit; everything else is deliberately left for a human (or the Node
engine's model proposer). A rule that guesses is worse than no rule, because
the verify gate will reject the guess anyway — after burning an iteration
and a ledger entry to prove it.

This is a faithful port of the TypeScript engine's Python and Go rules:
F401 (unused import), I001 (import-block sorting), the assertion-revealed
constant fix (pytest / testify / if-got / assert_eq! shapes), Rust's
unused `use` import, and Go's unused import.
TS rules (TS6133, TS2307, …) stay with the Node engine.
"""

import glob
import math
import os
import re
import uuid

_STDLIB = {
    "abc", "argparse", "array", "asyncio", "base64", "bisect", "calendar",
    "collections", "concurrent", "configparser", "contextlib", "copy", "csv",
    "dataclasses", "datetime", "decimal", "difflib", "enum", "errno",
    "fractions", "functools", "getpass", "glob", "gzip", "hashlib", "heapq",
    "html", "http", "importlib", "inspect", "io", "itertools", "json",
    "locale", "logging", "math", "multiprocessing", "os", "pathlib",
    "pickle", "platform", "queue", "random", "re", "shutil", "signal",
    "socket", "sqlite3", "ssl", "statistics", "string", "struct",
    "subprocess", "sys", "tempfile", "threading", "time", "traceback",
    "types", "typing", "unittest", "urllib", "uuid", "warnings", "weakref",
    "xml", "zipfile", "zoneinfo",
}

_SKIP = re.compile(r"(^|[\\/])(node_modules|dist|build|\.git|target)([\\/]|$)")
_IMPORT_LINE = re.compile(r"^(?:import\s+|from\s+\S+\s+import\s+)")
_IMPORT_SPEC = re.compile(r"^(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))")


def _esc(s: str) -> str:
    return re.escape(s)


def _mk_patch(file: str, find: str, replace: str, rationale: str) -> dict:
    return {
        "id": uuid.uuid4().hex[:8],
        "file": os.path.abspath(file),
        "find": find,
        "replace": replace,
        "rationale": rationale,
        "scope": "local",
    }


def _read(file: str) -> str:
    # newline="" keeps CRLF intact — anchors are built from split("\n"),
    # so on a CRLF file lines carry a trailing `\r` exactly like the TS
    # engine, and the verify gate's patches match the raw bytes.
    with open(file, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def propose_patches(finding: dict, source_root: str):
    code = finding.get("code")
    if code == "F401":
        return unused_python_import_patches(finding, source_root)
    if code == "I001":
        return unsorted_import_block_patches(finding, source_root)
    if code == "unused_imports":
        return unused_rust_import_patches(finding, source_root)
    if code in ("T201", "T202", "T203"):
        return best_practice_patches(finding, source_root, code)
    if code == "T001":
        return testgen_patches(finding, source_root)

    check = finding["check"]
    message = f"{finding['summary']} {finding.get('evidence', {}).get('message', '')}"
    if check == "py:test":
        return assertion_constant_patches(finding, source_root, "python")
    if check in ("go:test", "go:vet"):
        if re.search(r"imported and not used", message):
            return unused_go_import_patches(finding, source_root)
        return assertion_constant_patches(finding, source_root, "go")
    if check == "rs:test":
        return assertion_constant_patches(finding, source_root, "rust")
    return []


# -------------------------------------------------------------- python F401

_NAME_Q = re.compile(r"[`'\"]([^`'\"]+)[`'\"]")


def unused_python_import_patches(finding: dict, source_root: str):
    """Unused import (`F401 'os' imported but unused`). The mechanical fix is
    to drop the import. Whole-line imports are removed outright, with a
    surrounding blank line collapsed; multi-name imports (`import a, b`) have
    the one unused name removed from the list. Anything parenthesized or
    ambiguous is left for a human — a rule that guesses is worse than none."""
    file = finding.get("file")
    line = finding.get("line")
    if not file or not line:
        return []
    # ruff 0.16+ quotes the unused name with backticks (`os`), older
    # versions with single quotes — accept either.
    m = _NAME_Q.search(finding.get("evidence", {}).get("message", ""))
    if not m:
        return []
    name = m.group(1)
    text = _read(file)
    lines = text.split("\n")
    idx = line - 1
    if idx < 0 or idx >= len(lines):
        return []
    line_text = lines[idx]
    if not re.search(r"\bimport\b", line_text):
        return []

    # Whole-line import of exactly this name (optionally aliased) — drop it.
    whole = re.compile(
        rf"^\s*(?:import\s+{_esc(name)}(?:\s+as\s+\w+)?|from\s+\S+\s+import\s+{_esc(name)})\s*(?:#.*)?$"
    )
    if whole.match(line_text):
        return remove_line_patch(
            file, text, idx, f"'{name}' is imported but never used — removing the import."
        )

    # `import a, b` / `from x import a, b` — drop the unused name from the list.
    lst = re.match(r"^\s*(?:import|from\s+\S+\s+import)\s+(.+?)\s*(?:#.*)?$", line_text)
    if not lst or "(" in lst.group(1):
        return []
    items = [s.strip() for s in lst.group(1).split(",") if s.strip()]
    kept = [it for it in items if it.split(" as ")[0].strip() != name]
    if len(kept) == len(items):
        return []
    find = line_text
    replace = line_text.replace(lst.group(1), ", ".join(kept))
    return unique_or_empty(
        file, text, find, replace,
        f"'{name}' is imported but never used — removing it from the import.",
    )


def remove_line_patch(file: str, text: str, idx: int, rationale: str):
    """Remove one line by its exact text, collapsing a preceding blank line
    so the file does not gain a double blank. The anchor includes the line's
    own newline (or the one before it) so it matches exactly once; a
    non-unique anchor is refused rather than guessed at."""
    lines = text.split("\n")
    line = lines[idx] if idx < len(lines) else None
    if line is None or line.strip() == "":
        return []
    last = idx == len(lines) - 1
    find = ("" if idx == 0 else "\n") + line + ("" if last else "\n")
    replace = "" if idx == 0 else "\n"
    return unique_or_empty(file, text, find, replace, rationale)


def unique_or_empty(file: str, text: str, find: str, replace: str, rationale: str):
    """A patch whose anchor is exactly one occurrence — nothing else is safe."""
    if text.count(find) != 1:
        return []
    return [_mk_patch(file, find, replace, rationale)]


# -------------------------------------------------------------- python I001

def unsorted_import_block_patches(finding: dict, source_root: str):
    """Unsorted import block (`I001 Import block is un-sorted or
    un-formatted`). Order the block as isort does: stdlib first, then
    third-party, then first-party, alphabetical within each section, `import
    x` before `from x import`. Only plain consecutive import lines are
    sorted; a block with comments or parenthesized imports is left for a
    human. The verify gate re-runs the linter, so a sort that disagrees with
    the tool's preference is reverted, not shipped."""
    file = finding.get("file")
    line = finding.get("line")
    if not file or not line:
        return []
    text = _read(file)
    lines = text.split("\n")
    start_idx = line - 1
    if start_idx < 0 or start_idx >= len(lines):
        return []
    if not _IMPORT_LINE.match(lines[start_idx].strip()):
        return []

    # Walk to the block boundaries: consecutive plain import lines. A
    # comment ends the walk — sorting around comments is guesswork.
    fr = start_idx
    while fr > 0 and _IMPORT_LINE.match(lines[fr - 1].strip()) and "#" not in lines[fr - 1]:
        fr -= 1
    to = start_idx
    while to < len(lines) - 1 and _IMPORT_LINE.match(lines[to + 1].strip()) and "#" not in lines[to + 1]:
        to += 1
    block = lines[fr:to + 1]
    if len(block) < 2:
        return []
    if any("(" in l or ")" in l for l in block):
        return []

    dirname = os.path.dirname(file)
    from functools import cmp_to_key
    sorted_block = sorted(block, key=cmp_to_key(lambda a, b: compare_imports(a, b, dirname, source_root)))
    if sorted_block == block:
        return []

    find = "\n".join(block)
    replace = "\n".join(sorted_block)
    return unique_or_empty(
        file, text, find, replace,
        "Import block is out of order — sorting it (stdlib, third-party, first-party).",
    )


def import_section(statement: str, dirname: str, source_root: str) -> int:
    t = statement.strip()
    m = _IMPORT_SPEC.match(t)
    spec = (m.group(1) or m.group(2) or "").strip()
    if spec.startswith("."):
        return 2  # relative import → the repo's own code
    top = spec.split(".")[0]
    if top in _STDLIB:
        return 0
    # First-party: a package or module of the same name under the source root.
    if os.path.exists(os.path.join(source_root, top)) or os.path.exists(os.path.join(source_root, top + ".py")):
        return 2
    return 1


def compare_imports(a: str, b: str, dirname: str, source_root: str) -> int:
    sa = import_section(a, dirname, source_root)
    sb = import_section(b, dirname, source_root)
    if sa != sb:
        return -1 if sa < sb else 1

    def key(s: str):
        t = s.strip()
        m = _IMPORT_SPEC.match(t)
        mod = (m.group(1) or m.group(2) or "").lower()
        kind = 0 if t.startswith("import ") else 1
        return (mod, kind, t.lower())

    ka, kb = key(a), key(b)
    return -1 if ka < kb else (1 if ka > kb else 0)


# -------------------------------------------------------------- unused import (go)

def unused_go_import_patches(finding: dict, source_root: str):
    """`imported and not used: "fmt"` (a Go compile error reported by go
    test / go build). Remove the import spec — a whole-line `import "fmt"`
    or a `"fmt"` line inside an import block. The anchor must be unique or
    nothing is proposed."""
    file = finding.get("file")
    if not file:
        return []
    message = f"{finding['summary']} {finding.get('evidence', {}).get('message', '')}"
    m = re.search(r'imported and not used:\s*"?([\w./\-]+)"?', message)
    if not m:
        return []
    path = m.group(1)
    text = _read(file)
    lines = text.split("\n")
    in_block = re.compile(rf'^\s*"{_esc(path)}"(\s|//|$)')
    whole_line = re.compile(rf'^import\s+"{_esc(path)}"\s*$')
    idx = next(
        (i for i, l in enumerate(lines) if in_block.match(l) or whole_line.match(l.strip())),
        -1,
    )
    if idx == -1:
        return []
    return remove_line_patch(file, text, idx, f"'{path}' is imported but not used — removing the import.")



# -------------------------------------------------------------- unused import (rust)

def unused_rust_import_patches(finding: dict, source_root: str):
    """Unused `use` import (clippy `unused_imports`). Whole-line imports —
    `use std::fmt;`, optionally aliased — are removed outright, collapsing a
    surrounding blank line exactly like the Python rule. Group imports
    (`use a::{b, c};`) are left for a human: clippy names only the last
    segment, which cannot be re-anchored safely."""
    file = finding.get("file")
    line = finding.get("line")
    if not file or not line:
        return []
    message = f"{finding['summary']} {finding.get('evidence', {}).get('message', '')}"
    m = re.search(r"`([^`]+)`", message)
    if not m:
        return []
    path = m.group(1)
    text = _read(file)
    lines = text.split("\n")
    idx = line - 1
    if idx < 0 or idx >= len(lines):
        return []
    line_text = lines[idx]
    if not re.match(r"^\s*use\s+", line_text):
        return []
    whole = re.compile(r"^\s*use\s+" + _esc(path) + r"(?:\s+as\s+\w+)?\s*;\s*$")
    if not whole.match(line_text):
        return []
    return remove_line_patch(file, text, idx, f"'{path}' is imported but never used — removing the use.")


# -------------------------------------------------------------- best practices (T201-T203)

def best_practice_patches(finding: dict, source_root: str, kind: str):
    """The mechanically fixable best-practices findings from the
    `py:best-practices` check. Each rewrite is exact, anchored on the
    reported line, and semantically equivalent — the verify gate re-runs
    the checks, so a rewrite that disagrees with the language's semantics
    is reverted, not shipped."""
    file = finding.get("file")
    line = finding.get("line")
    if not file or not line:
        return []
    text = _read(file)
    lines = text.split("\n")
    idx = line - 1
    if idx < 0 or idx >= len(lines):
        return []
    line_text = lines[idx]

    if kind == "T201":
        # `type(x) == T` compares identity, not types — isinstance is the
        # intended check. The RHS guard refuses `type(x) == type(y)`.
        m = re.search(r"type\(\s*([^)]*?)\s*\)\s*(?:==|is)\s+(?!type\s*\()([A-Za-z_][\w.]*)", line_text)
        if not m:
            return []
        find = m.group(0)
        replace = f"isinstance({m.group(1)}, {m.group(2)})"
        rationale = "type() compares identity, not types — using isinstance()."
    elif kind == "T202":
        # `len(x) == 0` → `not x`; `len(x) != 0` / `len(x) > 0` → `x`; and
        # the mirrored `0 == len(x)` forms. Bare identifiers only.
        fwd = re.search(r"\blen\(([A-Za-z_]\w*)\)\s*(==|!=|>)\s*0\b", line_text)
        rev = re.search(r"\b0\s*(==|!=|<)\s*len\(([A-Za-z_]\w*)\)", line_text)
        if not (fwd or rev):
            return []
        m = fwd or rev
        # fwd captures (name, op); rev captures (op, name).
        name = fwd.group(1) if fwd else rev.group(2)
        op = fwd.group(2) if fwd else rev.group(1)
        find = m.group(0)
        replace = f"not {name}" if op == "==" else name
        rationale = "len() comparison against a literal — using truthiness instead."
    else:  # T203
        # `key in d.keys()` — the keys view is redundant; `in d` is equivalent.
        m = re.search(r"((?:'[^']*'|\"[^\"]*\"|[A-Za-z_]\w*)\s+in\s+)([A-Za-z_]\w*)\.keys\(\)", line_text)
        if not m:
            return []
        find = m.group(0)
        replace = m.group(1) + m.group(2)
        rationale = "'in d.keys()' — the keys view is redundant; 'in d' is equivalent."
    return unique_or_empty(file, text, find, replace, rationale)


# -------------------------------------------------------------- test generation (T001)

def testgen_patches(finding: dict, source_root: str):
    """A function with no tests (`py:testgen` T001). The mechanical answer
    is not a rewrite but a *new file*: a smoke test next to the module,
    covering every untested top-level function in one patch. The verify gate
    then runs pytest — if the module cannot even be imported, the new test
    fails and the file is reverted, which is exactly the honest signal."""
    file = finding.get("file")
    if not file:
        return []
    stem = os.path.splitext(os.path.basename(file))[0]
    test_path = os.path.join(os.path.dirname(file), f"test_{stem}.py")
    # The detector only reports modules with no sibling test file; if one
    # has appeared since, the finding is already resolved.
    if os.path.exists(test_path):
        return []

    text = _read(file)
    # Top-level only: `^` at column 0 never matches an indented nested def.
    funcs = [
        m for m in re.findall(r"^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(", text, re.M)
        if not m.startswith("_")
    ]
    if not funcs:
        return []

    # The import spec follows pytest's sys.path rule: walk up through
    # package dirs (those with __init__.py); the module is importable as
    # the dotted path from the first non-package ancestor.
    parts = [stem]
    d = os.path.dirname(file)
    while os.path.exists(os.path.join(d, "__init__.py")):
        parts.insert(0, os.path.basename(d))
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    spec = ".".join(parts)

    rel = os.path.relpath(file, source_root).replace("\\", "/")
    # Member names sorted case-insensitively (isort's default), so the
    # generated file is I001-clean and the verify gate has nothing to see.
    sorted_funcs = sorted(funcs, key=str.lower)
    # Two blank lines between top-level defs (PEP 8) — a generated file must
    # not introduce style findings in a stricter repo.
    body = "\n\n\n".join(
        f"def test_{f}_is_importable():\n    assert callable({f})" for f in sorted_funcs
    )
    content = "\n".join([
        f'"""Smoke tests for {rel} — generated by Kintsugi (no coverage found)."""',
        "",
        f"from {spec} import {', '.join(sorted_funcs)}",
        "",
        "",
        body,
        "",
    ])
    patch = _mk_patch(
        test_path, "", content,
        f"No test covers {rel} — generating a smoke test and letting the checks run it.",
    )
    patch["create"] = True
    return [patch]


# -------------------------------------------------------------- assertion → constant

def assertion_constant_patches(finding: dict, source_root: str, lang: str):
    """A failing assertion that reveals the right constant. pytest prints
    `assert 8.0 == 10`; go test prints `expected 10, got 5`. Neither names
    the code — but the test file line the check points at does: read it,
    find the call and the expected value, locate the function, and if its
    body computes `param * <literal>`, recompute the literal from the
    assertion's own numbers. Only a clean decimal result is patched."""
    file = finding.get("file")
    line = finding.get("line")
    if not file or not line:
        return []
    lines = _read(file).split("\n")
    test_line = lines[line - 1] if 0 <= line - 1 < len(lines) else ""
    parsed = parse_assertion(test_line, lang)
    if not parsed:
        return []

    impl = find_function_body(parsed["fn"], source_root, lang)
    if not impl:
        return []
    # Rust floats can carry a type suffix (`0.08_f64`); the others cannot.
    num = r"\d+(?:\.\d+)?(?:_?f(?:32|64))?" if lang == "rust" else r"\d+(?:\.\d+)?"
    re_ = re.compile(rf"\b{_esc(impl['param'])}\s*\*\s*({num})\b")
    m = re_.search(impl["body"])
    if not m:
        return []

    try:
        arg = float(parsed["arg"])
        expected = float(parsed["expected"])
    except ValueError:
        return []
    if not (math.isfinite(arg) and math.isfinite(expected)) or arg == 0:
        return []
    value = expected / arg
    literal = str(value)
    # A clean decimal only — `10/100 → 0.1`, but `10/3 → 3.3333333333333335`
    # is float noise, not a constant.
    if not re.match(r"^\d+\.?\d*$", literal) or len(literal) > 10:
        return []
    # Compare against the numeric part so a redundant `0.08_f64` -> `0.08`
    # rewrite (which changes nothing) is never proposed.
    num_part = re.sub(r"(?:_?f(?:32|64))$", "", m.group(1))
    if literal == num_part:
        return []

    find = m.group(0)
    replace = re.sub(r"\d+(?:\.\d+)?(?:_?f(?:32|64))?$", literal, find)
    current = float(num_part) * arg
    rationale = (
        f"The test asserts {parsed['fn']}({parsed['arg']}) == {parsed['expected']}; "
        f"the constant '{impl['param']} * {m.group(1)}' makes it "
        f"{parsed['fn']}({parsed['arg']}) == {current:g} — setting it to {literal}."
    )
    return unique_or_empty(impl["file"], impl["text"], find, replace, rationale)


def parse_assertion(line: str, lang: str):
    """Parse the failing assertion's own source line into fn/arg/expected."""
    # `assert f(n) == want` and the mirror `assert want == f(n)`. The test
    # line is indented, so these are searches, not anchored matches.
    if lang == "python":
        call = re.search(r"assert\s+(\w+)\s*\(\s*([\d.]+)\s*\)\s*==\s*([\d.]+)", line)
        if call:
            return {"fn": call.group(1), "arg": call.group(2), "expected": call.group(3)}
        mirror = re.search(r"assert\s+([\d.]+)\s*==\s*(\w+)\s*\(\s*([\d.]+)\s*\)", line)
        if mirror:
            return {"fn": mirror.group(2), "arg": mirror.group(3), "expected": mirror.group(1)}
        return None
    if lang == "rust":
        # `assert_eq!(f(n), want)` and the mirror `assert_eq!(want, f(n))`.
        call = re.search(r"assert_eq!\s*\(\s*(\w+)\s*\(\s*([\d.]+)\s*\)\s*,\s*([\d.]+)", line)
        if call:
            return {"fn": call.group(1), "arg": call.group(2), "expected": call.group(3)}
        mirror = re.search(r"assert_eq!\s*\(\s*([\d.]+)\s*,\s*(\w+)\s*\(\s*([\d.]+)\s*\)", line)
        if mirror:
            return {"fn": mirror.group(2), "arg": mirror.group(3), "expected": mirror.group(1)}
        return None
    # Go: testify Equal(t, want, got) and the plain `if got := f(n); got != want`.
    eq = re.search(r"\.Equal\(\s*t,\s*([\d.]+),\s*(\w+)\s*\(\s*([\d.]+)\s*\)", line)
    if eq:
        return {"fn": eq.group(2), "arg": eq.group(3), "expected": eq.group(1)}
    got = re.search(r"if\s+\w+\s*:=\s*(\w+)\s*\(\s*([\d.]+)\s*\)\s*;\s*\w+\s*!=\s*([\d.]+)", line)
    if got:
        return {"fn": got.group(1), "arg": got.group(2), "expected": got.group(3)}
    return None


def find_function_body(fn: str, source_root: str, lang: str):
    """The function's source file, text, body, and first parameter name."""
    ext = "py" if lang == "python" else ("go" if lang == "go" else "rs")
    if lang == "python":
        sig_re = re.compile(rf"def\s+{_esc(fn)}\s*\(([^)]*)\)")
        param_re = re.compile(r"^\s*([A-Za-z_]\w*)\s*(?::[^,)]+)?(?:,|$)")
        test_file = re.compile(r"(?:^|[/\\])test_[^/\\]*\.py$|(?:^|[/\\])[^/\\]*_test\.py$")
    elif lang == "go":
        sig_re = re.compile(rf"func\s+{_esc(fn)}\s*\(([^)]*)\)")
        param_re = re.compile(r"^\s*([A-Za-z_]\w*)\s+[^,)]+(?:,|$)")
        test_file = re.compile(r"\._test\.go$")
    else:
        sig_re = re.compile(rf"fn\s+{_esc(fn)}\s*\(([^)]*)\)")
        param_re = re.compile(r"^\s*([A-Za-z_]\w*)\s*:")
        test_file = re.compile(r"(^|[/\\])tests([/\\]|$)|(^|[/\\])[^/\\]*_test\.rs$")

    for f in glob.glob(os.path.join(source_root, "**", f"*.{ext}"), recursive=True):
        rel = os.path.relpath(f, source_root).replace("\\", "/")
        if _SKIP.search(rel):
            continue
        # The defect is in product code, not in the test that caught it.
        if test_file.search(rel):
            continue
        text = _read(f)
        sig = sig_re.search(text)
        if not sig:
            continue
        params = param_re.match(sig.group(1))
        if not params:
            continue
        body = extract_body(text, sig.start(), lang)
        if body is None:
            continue
        return {"file": f, "text": text, "body": body, "param": params.group(1)}
    return None


def extract_body(text: str, sig_index: int, lang: str) -> str | None:
    """The function body starting at sig_index: to the next sibling, or EOF."""
    from_pos = text.find("\n", sig_index)
    if from_pos == -1:
        return None
    if lang == "rust":
        # Brace-matched, with string literals skipped so `format!("{x}")`
        # cannot defeat the counter.
        open_pos = text.find("{", sig_index)
        if open_pos == -1:
            return None
        depth = 0
        in_str = False
        for i in range(open_pos, len(text)):
            c = text[i]
            if in_str:
                if c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return text[open_pos + 1:i]
        return None
    if lang == "go":
        end = text.find("\n\nfunc ", from_pos + 1)
        until = len(text) if end == -1 else end + 1
        return text[from_pos + 1:until]
    # Python: the body is indented deeper than the `def` line; it ends at
    # the first non-blank line at the def's indent or shallower.
    def_line = text[text.rfind("\n", 0, sig_index) + 1:from_pos]
    indent = len(re.match(r"^[ \t]*", def_line).group(0))
    body_lines = []
    for l in text[from_pos + 1:].split("\n"):
        if body_lines and l.strip() != "" and len(re.match(r"^[ \t]*", l).group(0)) <= indent:
            break
        body_lines.append(l)
    return "\n".join(body_lines)
