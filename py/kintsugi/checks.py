"""Running check commands and turning their output into findings.

Checks run with cwd = source root, shell-resolved, so `pytest` and `ruff`
find the repo's own toolchain. A non-zero exit with no parseable finding is
a *crash*, not a defect: the loop reports it and refuses to heal it, because
a repair loop that "heals" a broken harness is a repair loop that rewrites
working code because its own plumbing failed.
"""

import os
import re
import subprocess
import time

from .parsers import parse_lines, parse_radon, parse_rust, parse_strict

# ANSI CSI color sequences. CI hosts force tool color (rustup actions set
# CARGO_TERM_COLOR=always), and colored diagnostics carry escape codes before
# the `warning:`/`-->`/`panicked at` anchors every parser relies on:
#
#   \x1b[1m\x1b[93mwarning\x1b[0m: unused import: `std::fmt`
#    \x1b[1m\x1b[96m--> \x1b[0msrc/lib.rs:1:5
#
# Output is sanitized at this one funnel so every parser sees plain text.
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


def _parse(defn, output: str, cwd: str):
    parser = defn.get("parser")
    if parser == "strict":
        return parse_strict(output, cwd, defn["name"])
    if parser == "lines":
        return parse_lines(output, cwd, defn["name"])
    if parser == "rust":
        return parse_rust(output, cwd, defn["name"])
    if parser == "radon":
        return parse_radon(output, cwd, defn["name"])
    # tsc/tap/spec output shapes belong to the Node engine; a config that
    # declares them here is a config that cannot be read.
    return []


def run_check(defn, cwd: str, timeout_ms: int | None = None):
    """Run one check command and return a CheckResult-shaped dict."""
    if timeout_ms is None:
        # A check can declare a longer timeout for cold-building
        # toolchains (cargo compiles the crate before testing).
        timeout_ms = defn.get("timeoutMs", 120_000)
    started = time.time()
    env = dict(os.environ)
    env.pop("NODE_TEST_CONTEXT", None)

    try:
        proc = subprocess.Popen(
            defn["command"],
            shell=True,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    except OSError as err:
        return {
            "check": defn["name"],
            "findings": [],
            "exitCode": -1,
            "durationMs": int((time.time() - started) * 1000),
            "crashed": True,
            "output": f"failed to start: {err}",
        }

    killed = False
    try:
        raw, _ = proc.communicate(timeout=timeout_ms / 1000)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        proc.kill()
        raw, _ = proc.communicate()
        code = -2
        killed = True

    # Decode UTF-8 explicitly: the engines' own scanners (and tools like
    # ruff) emit UTF-8, but text=True would decode with the *locale* (cp1252
    # on Windows) and mangle every non-ASCII byte — corrupting messages and
    # with them the fingerprints the ledger keys on. This mirrors the TS
    # engine's String(buffer) decode, so both engines agree byte-for-byte.
    output = _strip_ansi((raw or b"").decode("utf-8", errors="replace"))
    duration_ms = int((time.time() - started) * 1000)
    # Exit 0 means the check passed — its output may still *look* like
    # findings, but a passing check contributes no findings by definition.
    # Except when the check declares parseOnExit0 (analysis tools like
    # radon always exit 0 — their findings live in the text, not the
    # status). pytest exits 5 with "no tests ran" for an empty suite — that
    # is a clean state, not a defect and not a broken harness, and it must
    # not block the verify gate (test generation exists precisely to give a
    # testless repo its first tests).
    empty_suite = re.search(r"no tests ran", output, re.IGNORECASE) is not None
    parsed = [] if empty_suite or (code == 0 and not defn.get("parseOnExit0")) else _parse(defn, output, cwd)

    # A check owns its defect class: filterCodes keeps only the codes it was
    # configured for, and a configured severity overrides the parser default.
    findings = parsed
    if defn.get("filterCodes"):
        allowed = set(defn["filterCodes"])
        findings = [f for f in findings if f.get("code") in allowed]
    if defn.get("severity"):
        findings = [{**f, "severity": defn["severity"]} for f in findings]

    return {
        "check": defn["name"],
        "findings": findings,
        "exitCode": code,
        "durationMs": duration_ms,
        "crashed": killed or (not empty_suite and code != 0 and len(parsed) == 0),
        "output": output,
    }
