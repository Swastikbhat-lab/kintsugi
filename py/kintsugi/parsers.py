"""Turning raw tool output into typed findings.

A finding is only as good as its anchor: a file, a line, a machine code and
a message that the healer can act on. Output that cannot name a file inside
the source root is not a finding — it is noise, and a loop that heals noise
is how an auto-fixer starts breaking things.

This is a faithful port of the TypeScript engine's `strict` and `lines`
parsers — the two contracts the non-Node path (pytest, ruff, go test,
go vet, custom checks) speaks.
"""

import os
import re

from .fingerprint import fingerprint

# Tool noise that must never be treated as repo code: vendored deps, build
# output, VCS internals, virtualenvs and their package dirs, and the caches
# Python toolchains drop inside the repo.
SKIP = re.compile(
    r"(^|[\\/])(node_modules|dist|build|\.git|\.venv|venv|site-packages|"
    r"dist-packages|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|"
    r"\.tox|target)([\\/]|$)"
)

_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")


def is_abs_path(p: str) -> bool:
    # `C:/…` is absolute on Windows — and tool output can carry Windows
    # paths on any OS, so treat a drive-letter prefix as absolute everywhere.
    return os.path.isabs(p) or bool(_DRIVE.match(p))


def normalize_path(p: str, cwd: str) -> str | None:
    """Normalize a reported path against the source root; drop anything
    outside it. Returns forward-slash absolute paths so the rest of the
    engine never has to care which OS produced them."""
    cleaned = p.strip().replace("\\", "/")
    if not cleaned:
        return None

    # `file:///C:/repo/x.ts` → `C:/repo/x.ts`; `file:///repo/x.ts` →
    # `/repo/x.ts`. Stripping `file://` wholesale would drop the root slash
    # on POSIX and turn an absolute path into a relative one.
    if cleaned.startswith("file://"):
        rest = cleaned[len("file://"):]
        if re.match(r"^/[A-Za-z]:", rest):
            rest = rest[1:]
        abs_p = rest if is_abs_path(rest) else os.path.abspath(os.path.join(cwd, rest))
    else:
        abs_p = cleaned if is_abs_path(cleaned) else os.path.abspath(os.path.join(cwd, cleaned))
    abs_p = abs_p.replace("\\", "/")

    try:
        rel = os.path.relpath(abs_p, cwd).replace("\\", "/")
    except ValueError:
        # Different drive on Windows — the path is outside the root.
        return None
    if rel.startswith("..") or os.path.isabs(rel):
        return None
    if SKIP.search(rel):
        return None
    return abs_p


# ------------------------------------------------------------- strict

# Optional drive letter, then a path token, then `:line`, optional `:col`,
# then the message. The path must look like a file (an extension or a
# separator) and never contain whitespace, so `FAIL\texample.com/x\t0.02s`
# and `1 failed in 0.12s` cannot become phantom findings. The drive letter
# is captured separately — a non-capturing group would swallow `C:` and
# leave a root-relative head that passes the outside-root check drive-less.
_STRICT_RE = re.compile(r"^\s*(?:(?:([A-Za-z]):)?([^:\s]+):(\d+)(?::(\d+))?:\s*(.*))$")
_FILEISH = re.compile(r"\.\w+$|[\\/]")
_FRAME = re.compile(r"^in [\w.]+$")
_WARNING = re.compile(r"^[A-Za-z][\w.]*Warning:\s")
_CODE = re.compile(r"^([A-Z]+\d+)\b")


def parse_strict(output: str, cwd: str, check: str):
    """The zero-config contract for non-TS toolchains — pytest, go test,
    go vet, ruff. Every finding must be anchored to a `file:line` inside the
    source root; unlike `lines`, a bare line is never a finding.

    Shapes read:

      pytest --tb=line   test_pricing.py:7: assert 8 == 10
      ruff               src/foo.py:12:5: F401 'os' imported but unused
      go test            foo_test.go:25: expected 10, got 5
      go vet             ./foo.go:12:2: fmt.Println is unused
    """
    findings = []
    for raw in output.split("\n"):
        # Trim CR/LF and padding: tool output on Windows is CRLF, and a
        # trailing `\r` defeats the `$` anchor.
        m = _STRICT_RE.match(raw.strip())
        if not m:
            continue
        head = (m.group(1) + ":" if m.group(1) else "") + m.group(2)
        if not _FILEISH.search(head):
            continue
        file = normalize_path(head, cwd)
        if not file:
            continue
        line = int(m.group(3))
        col = int(m.group(4)) if m.group(4) else None
        message = m.group(5).strip()
        # A traceback frame (`test_x.py:7: in test_tax_rate`) is scaffolding;
        # the error line that follows it carries the defect.
        if _FRAME.match(message):
            continue
        # pytest's `warnings summary` block lists `path:line:
        # CategoryWarning: message` lines in the same shape as findings — but
        # they are not the failure the check is reporting, so a noisy suite
        # must not surface them as phantom defects.
        if _WARNING.match(message):
            continue
        # Tool codes travel inside the message for some tools (ruff: `F401 [*]
        # 'os' imported but unused`) — lift the leading code token out so
        # rules can dispatch on it the way they do on TSxxxx.
        code_m = _CODE.match(message)
        code = code_m.group(1) if code_m else None
        evidence = {"message": message}
        if col is not None:
            evidence["col"] = col
        if code:
            evidence["code"] = code
        findings.append({
            "fingerprint": fingerprint(check, file, code or "", message),
            "check": check,
            "severity": "minor",
            "summary": message,
            "file": file,
            "line": line,
            "code": code,
            "evidence": evidence,
        })
    return findings


# ------------------------------------------------------------- lines

_LINES_RE = re.compile(r"^(?:([^:]+):(\d+:)?\s*)?(.*)$")


def parse_lines(output: str, cwd: str, check: str):
    """The plain-text contract for custom checks. Each non-empty line is
    either `path[:line]: message` or a bare message; a `path` must look like
    one (a dot-extension or a separator), so a message like `version-drift:
    …` is not mistaken for a file named `version-drift`."""
    findings = []
    for raw in output.split("\n"):
        line = raw.strip()
        if not line:
            continue
        m = _LINES_RE.match(line)
        head = m.group(1)
        looks_like_file = (
            bool(head)
            and " " not in head
            and (_FILEISH.search(head) is not None)
        )
        file = normalize_path(head, cwd) if looks_like_file else None
        line_no = int(m.group(2)[:-1]) if looks_like_file and m.group(2) else None
        message = (m.group(3) if looks_like_file else line).strip()
        if not message:
            continue
        findings.append({
            "fingerprint": fingerprint(check, file, "", message),
            "check": check,
            "severity": "minor",
            "summary": message,
            "file": file,
            "line": line_no,
            "evidence": {"message": message},
        })
    return findings

# ------------------------------------------------------------- radon

_RADON_HEADER = re.compile(r"^\s*([^\s].*\.py)\s*$")
_RADON_FN = re.compile(r"^\s+[FMC]\s+(\d+):(\d+)\s+(\S+)\s+-\s+([A-F])\s+\((\d+)\)\s*$")


def parse_radon(output: str, cwd: str, check: str):
    """radon cyclomatic-complexity output (`radon cc -s --min C`). Unlike
    the other parsers this check runs with parseOnExit0: radon always exits
    0 — its findings live in the text, not the status. The plain format is
    a per-file header line followed by indented function lines:

      src/tax.py
          F 1:0 apply_tax - C (11)

    Only C+ ranks are emitted by the check command (`--min C`); the parser
    also drops A/B defensively, because complexity below C is not a defect
    a repair loop should spend an iteration on.
    """
    findings = []
    file = None
    for raw in output.split("\n"):
        line = raw.rstrip("\r")
        if not line:
            continue
        header = _RADON_HEADER.match(line)
        if header:
            file = normalize_path(header.group(1), cwd)
            continue
        m = _RADON_FN.match(line)
        if not m or not file:
            continue
        rank = m.group(4)
        if rank in ("A", "B"):
            continue
        cc = int(m.group(5))
        name = m.group(3)
        message = f"cyclomatic complexity {rank} ({cc}): {name}"
        code = f"CC_{rank}"
        findings.append({
            "fingerprint": fingerprint(check, file, code, message),
            "check": check,
            "severity": "minor",
            "summary": message,
            "file": file,
            "line": int(m.group(1)),
            "code": code,
            "evidence": {"message": message, "rank": rank, "complexity": cc, "name": name},
        })
    return findings


# ------------------------------------------------------------- rust

_PANIC = re.compile(r"panicked at\s+([^:\s]+):(\d+)(?::(\d+))?:?\s*(.*)$")
_DIAG = re.compile(r"^(?:warning|error(?:\[[A-Z]+\d+\])?):\s*(.+)$")
_LOC = re.compile(r"^\s*-->\s+([^:\s]+):(\d+)(?::(\d+))?\s*$")
_ERR = re.compile(r"^error(?:\s*\[([A-Z]+\d+)\])?:\s*(.*)$")
_WARN = re.compile(r"^warning:\s*(.*)$")
_UNUSED_IMPORT = re.compile(r"^unused import:")


def _rust_diagnostic(line: str):
    """Lift a machine code and the bare message out of a rust diagnostic
    line. `error[E0425]:` carries a real code; `error:` is a denied lint
    (clippy `-D warnings`), so a lint-shaped message still gets its code."""
    err = _ERR.match(line)
    if err:
        code = err.group(1)
        text = err.group(2)
        return {"code": code or ("unused_imports" if _UNUSED_IMPORT.match(text) else None), "text": text}
    warn = _WARN.match(line)
    if warn:
        text = warn.group(1)
        return {"code": "unused_imports" if _UNUSED_IMPORT.match(text) else None, "text": text}
    return {"code": None, "text": line}


def parse_rust(output: str, cwd: str, check: str):
    """Rust toolchain output — cargo test panics and rustc/clippy
    diagnostics, in the default text format and `--message-format=short`.

    cargo test embeds the panic location in the frame line rather than on
    its own:

      thread 'tests::test_applies_tax' panicked at src/lib.rs:8:5:
      assertion `left == right` failed
        left: 8.0
        right: 10

    rustc and clippy default to a *paired* format — a message line, then
    the `--> path:line[:col]` location line:

      warning: unused import: `std::fmt`
        --> src/lib.rs:2:5

    …which this parser joins into one finding. The short format is one line
    per diagnostic and parses like strict.
    """
    findings = []
    lines = output.split("\n")

    def push(head, line_no, col, diag):
        file = normalize_path(head, cwd)
        if not file:
            return
        info = _rust_diagnostic(diag)
        code = info["code"]
        text = info["text"]
        evidence = {"message": text}
        if col is not None:
            evidence["col"] = col
        if code:
            evidence["code"] = code
        findings.append({
            "fingerprint": fingerprint(check, file, code or "", text),
            "check": check,
            "severity": "minor",
            "summary": text,
            "file": file,
            "line": line_no,
            "code": code,
            "evidence": evidence,
        })

    # Pass 1 — panic frames. The panic message is the next non-empty line;
    # the `left:`/`right:` value lines after it are not the message.
    for i, raw in enumerate(lines):
        m = _PANIC.search(raw)
        if not m:
            continue
        message = m.group(4).strip()
        if not message:
            nxt = next((l for l in lines[i + 1:] if l.strip()), "")
            if nxt and not re.match(r"^\s*left:", nxt):
                message = nxt.strip()
        if not message:
            continue
        push(m.group(1), int(m.group(2)), int(m.group(3)) if m.group(3) else None, message)

    # Pass 2 — paired diagnostics: a message line, then the `-->` location
    # line within the same block (a blank line between them is legal).
    for i, raw in enumerate(lines):
        m = _DIAG.match(raw)
        if not m:
            continue
        for j in range(i + 1, min(i + 8, len(lines))):
            loc = _LOC.match(lines[j])
            if loc:
                push(loc.group(1), int(loc.group(2)), int(loc.group(3)) if loc.group(3) else None, raw)
                break
            t = lines[j].strip()
            if j > i + 1 and t and re.match(r"^(?:warning|error|note|help)", t):
                break

    # Pass 3 — strict-style anchored lines (clippy/rustc short format, and
    # any other `path:line: message` cargo emits).
    for raw in lines:
        m = _STRICT_RE.match(raw.strip())
        if not m:
            continue
        head = (m.group(1) + ":" if m.group(1) else "") + m.group(2)
        if not _FILEISH.search(head):
            continue
        message = m.group(5).strip()
        if not message:
            continue
        push(head, int(m.group(3)), int(m.group(4)) if m.group(4) else None, message)

    return findings
