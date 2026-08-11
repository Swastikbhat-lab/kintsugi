"""Cross-engine parity — the regression test for the claim that the
TypeScript and Python engines are interchangeable.

Both engines run against the *same* fixture directory (fingerprints embed
the absolute file path, so identity only holds for the same path):

  - a fresh-ledger run of each engine must produce identical JSON reports
    (modulo the random run id), identical fingerprint sets, and identical
    per-fingerprint attempt semantics (outcome, find, replace, rationale);
  - with one shared ledger, Python's committed fingerprints must be reused
    by TypeScript's run on the re-planted defects (2 committed attempts per
    key, one from each engine), and a clean repo must converge instantly
    with the shared ledger in *both* directions;
  - exit codes must agree on every path, including the quarantine path
    (3 failing runs, then --quarantined-ok once the ledger has exhausted
    the finding).

The TypeScript engine is driven as a real subprocess — node + tsx from the
repo root — so nothing is stubbed on either side.
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_DIR = Path(__file__).resolve().parents[1]
TSX = REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
TS_CLI = REPO_ROOT / "src" / "cli.ts"
NODE = shutil.which("node")
HAS_TS = bool(NODE) and TSX.exists() and TS_CLI.exists()


def _find_pytest():
    # sys.executable first: the exact interpreter running this suite has
    # pytest installed both in CI (pip install) and in dev (repo venv).
    cands = [os.environ.get("PYTEST"), sys.executable, "python3", "python"]
    for c in cands:
        if not c:
            continue
        try:
            r = subprocess.run([c, "-m", "pytest", "--version"],
                               capture_output=True, timeout=15, text=True)
            if r.returncode == 0:
                return c
        except Exception:
            continue
    return None


def _find_ruff(pytest):
    for c in [os.environ.get("RUFF"), "ruff"]:
        if not c:
            continue
        try:
            r = subprocess.run([c, "--version"], capture_output=True, timeout=15, text=True)
            if r.returncode == 0:
                return c
        except Exception:
            continue
    try:
        r = subprocess.run([pytest, "-m", "ruff", "--version"],
                           capture_output=True, timeout=15, text=True)
        if r.returncode == 0:
            return f"{pytest} -m ruff"
    except Exception:
        pass
    return None


PYTEST = _find_pytest()
RUFF = _find_ruff(PYTEST) if PYTEST else None

pytestmark = pytest.mark.skipif(
    not PYTEST or not RUFF or not HAS_TS,
    reason="needs pytest+ruff (PYTEST/RUFF) and the TS engine (node + repo node_modules)",
)


# ------------------------------------------------------------- helpers

def _write(path: Path, content: str) -> None:
    # Explicit LF: both engines' rules anchor on the bytes they read, and
    # the TypeScript engine's find/replace strings are LF-built.
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)


def make_fixture(tmp_path: Path) -> None:
    """The standard three-defect fixture: stale constant, unsorted imports
    (I001), unused import (F401)."""
    src = tmp_path / "src"
    src.mkdir(exist_ok=True)
    _write(src / "tax.py", "def apply_tax(amount: float) -> float:\n    return amount * 0.08\n")
    _write(src / "util.py", "import os\n\n\ndef greet(name: str) -> str:\n    return f\"hello {name}\"\n")
    _write(src / "app.py",
           "import sys\nimport os\n\n\ndef run() -> str:\n    return f\"{os.name}:{sys.platform}\"\n")
    _write(tmp_path / "test_tax.py",
           "from src.tax import apply_tax\n\n\ndef test_apply_tax():\n    assert apply_tax(100) == 10\n")
    _write(tmp_path / "pyproject.toml",
           '[project]\nname = "tax-demo"\nversion = "0.1.0"\n\n'
           '[tool.ruff.lint]\nselect = ["E4", "E7", "E9", "F", "I"]\n')
    _write(tmp_path / "kintsugi.config.json", json.dumps({
        "checks": [
            {"name": "py:test",
             "command": f'"{PYTEST}" -m pytest -q --tb=line',
             "parser": "strict", "severity": "blocker"},
            {"name": "py:lint",
             "command": f"{RUFF} check . --output-format=concise",
             "parser": "strict", "severity": "minor"},
        ],
    }, indent=2))


def make_quarantine(tmp_path: Path) -> None:
    """A defect no mechanical rule can reach: a function body with no
    constant, no import — nothing for the rules to anchor on."""
    src = tmp_path / "src"
    src.mkdir(exist_ok=True)
    _write(src / "tax.py", "def apply_tax(amount: float) -> float:\n    return amount\n")
    _write(tmp_path / "test_tax.py",
           "from src.tax import apply_tax\n\n\ndef test_apply_tax():\n    assert apply_tax(100) == 10\n")
    _write(tmp_path / "pyproject.toml",
           '[project]\nname = "tax-demo"\nversion = "0.1.0"\n')
    _write(tmp_path / "kintsugi.config.json", json.dumps({
        "checks": [
            {"name": "py:test",
             "command": f'"{PYTEST}" -m pytest -q --tb=line',
             "parser": "strict", "severity": "blocker"},
        ],
    }, indent=2))


def _decode(r: subprocess.CompletedProcess) -> subprocess.CompletedProcess:
    # Both engines emit UTF-8 on stdout regardless of the console codepage
    # (the TS engine raw, the py CLI reconfigured), so decode as UTF-8
    # explicitly — text=True would use the locale encoding (cp1252 on
    # Windows) and mangle non-ASCII like the em dash in rationales.
    r.stdout = r.stdout.decode("utf-8", errors="replace")
    r.stderr = r.stderr.decode("utf-8", errors="replace")
    return r


def run_ts(tmp_path: Path, ledger: Path, *extra: str) -> subprocess.CompletedProcess:
    return _decode(subprocess.run(
        [NODE, str(TSX), str(TS_CLI), "--source", str(tmp_path),
         "--state", str(ledger), *extra],
        capture_output=True, timeout=300,
    ))


def run_py(tmp_path: Path, ledger: Path, *extra: str) -> subprocess.CompletedProcess:
    return _decode(subprocess.run(
        [sys.executable, "-m", "kintsugi", "--source", str(tmp_path),
         "--state", str(ledger), *extra],
        capture_output=True, timeout=300, cwd=str(PY_DIR),
    ))


def extract_report(stdout: str) -> dict:
    """The report JSON is the only output starting at column 0 (loop events
    are indented); slice from the first such line to EOF."""
    lines = stdout.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("{"):
            return json.loads("\n".join(lines[i:]))
    raise AssertionError(f"no JSON report in engine output:\n{stdout}")


def ledger_semantics(path: Path) -> dict:
    """fingerprint -> sorted list of {outcome, find, replace, rationale,
    scope} for every attempt in a ledger file."""
    out = {}
    for a in json.loads(path.read_text(encoding="utf-8")):
        out.setdefault(a["fingerprint"], []).append({
            "outcome": a["outcome"],
            "find": a["patch"]["find"],
            "replace": a["patch"]["replace"],
            "rationale": a["patch"]["rationale"],
            "scope": a["patch"]["scope"],
        })
    return {f: sorted(v, key=str) for f, v in out.items()}


# ------------------------------------------------------------- tests

def test_fresh_ledger_parity(tmp_path):
    """Same fixture, fresh ledger each: identical reports, fingerprints,
    and per-fingerprint attempt semantics."""
    make_fixture(tmp_path)
    ts = run_ts(tmp_path, tmp_path / "ledger-ts.json", "--json")
    assert ts.returncode == 0, ts.stdout + ts.stderr
    ts_report = extract_report(ts.stdout)
    ts_ledger = tmp_path / "ledger-ts.json"

    make_fixture(tmp_path)  # reset the SAME directory
    py = run_py(tmp_path, tmp_path / "ledger-py.json", "--json")
    assert py.returncode == 0, py.stdout + py.stderr
    py_report = extract_report(py.stdout)
    py_ledger = tmp_path / "ledger-py.json"

    ts_report.pop("runId", None)
    py_report.pop("runId", None)
    assert ts_report == py_report, (
        f"reports differ:\nTS={ts_report}\nPY={py_report}")

    ts_keys = ledger_semantics(ts_ledger)
    py_keys = ledger_semantics(py_ledger)
    assert set(ts_keys) == set(py_keys), (
        f"fingerprint sets differ:\nTS={sorted(ts_keys)}\nPY={sorted(py_keys)}")
    for f, attempts in ts_keys.items():
        assert py_keys.get(f) == attempts, (
            f"attempt semantics differ for {f}:\nTS={attempts}\nPY={py_keys.get(f)}")
    assert len(ts_keys) == 3, f"expected 3 committed defects, got {sorted(ts_keys)}"


def test_shared_ledger_across_engines(tmp_path):
    """Python commits 3 fixes; the defects are re-planted; TypeScript repairs
    them with the SAME ledger — each fingerprint must gain a second committed
    attempt from the other engine. A clean repo then converges instantly in
    both directions, proving each engine reads the other's ledger."""
    ledger = tmp_path / "ledger.json"
    make_fixture(tmp_path)
    py = run_py(tmp_path, ledger)
    assert py.returncode == 0, py.stdout + py.stderr

    make_fixture(tmp_path)  # re-plant the same three defects
    ts = run_ts(tmp_path, ledger)
    assert ts.returncode == 0, ts.stdout + ts.stderr

    per = {}
    for a in json.loads(ledger.read_text(encoding="utf-8")):
        per.setdefault(a["fingerprint"], []).append(a["outcome"])
    assert len(per) == 3, f"expected 3 defect fingerprints, got {sorted(per)}"
    for f, outcomes in per.items():
        assert outcomes.count("committed") == 2, (
            f"{f}: expected one committed attempt from each engine, got {outcomes}")
        assert len(outcomes) == 2, f"{f}: expected exactly 2 attempts, got {outcomes}"

    # The repo is now clean. Both engines must converge instantly (zero
    # findings, zero commits) reading the ledger the other engine wrote.
    for run in (run_ts, run_py):
        clean = run(tmp_path, ledger, "--json")
        assert clean.returncode == 0, clean.stdout + clean.stderr
        report = extract_report(clean.stdout)
        assert report["findingsRemaining"] == 0, report
        assert report["committed"] == [], report
        assert report["status"] == "converged", report


def test_quarantine_exit_code_parity(tmp_path):
    """A defect no rule can reach: both engines quarantine it and exit 1 for
    three runs; once the ledger has exhausted the finding, --quarantined-ok
    must yield exit 0 in both."""
    make_quarantine(tmp_path)
    for name, run in (("ts", run_ts), ("py", run_py)):
        ledger = tmp_path / f"ledger-{name}.json"
        first = run(tmp_path, ledger, "--json")
        assert first.returncode == 1, (
            f"{name} run 1: expected exit 1 (quarantined), got {first.returncode}\n"
            + first.stdout + first.stderr)
        # The finding is quarantined for this run, but stays actionable in
        # the ledger (a future model run must not be blinded).
        first_report = extract_report(first.stdout)
        assert len(first_report["quarantined"]) == 1, first_report
        assert first_report["actionableRemaining"] == 1, first_report
        for i in range(1, 3):
            r = run(tmp_path, ledger)
            assert r.returncode == 1, (
                f"{name} run {i + 1}: expected exit 1 (quarantined), got {r.returncode}\n"
                + r.stdout + r.stderr)
        # Three non-committed attempts exhaust the finding (limit 3), so
        # --quarantined-ok now relaxes the exit code in both engines.
        ok = run(tmp_path, ledger, "--quarantined-ok", "--json")
        assert ok.returncode == 0, (
            f"{name} --quarantined-ok: expected exit 0, got {ok.returncode}\n"
            + ok.stdout + ok.stderr)
        report = extract_report(ok.stdout)
        assert report["actionableRemaining"] == 0, report
        assert report["findingsRemaining"] == 1, report
