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
    r"\.tox)([\\/]|$)"
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
# and `1 failed in 0.12s` cannot become phantom findings.
_STRICT_RE = re.compile(r"^\s*(?:(?:[A-Za-z]:)?([^:\s]+):(\d+)(?::(\d+))?:\s*(.*))$")
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
        head = m.group(1)
        if not _FILEISH.search(head):
            continue
        file = normalize_path(head, cwd)
        if not file:
            continue
        line = int(m.group(2))
        col = int(m.group(3)) if m.group(3) else None
        message = m.group(4).strip()
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
