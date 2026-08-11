import os
import subprocess
import sys

import pytest

from kintsugi.loop import Loop


def _find_pytest():
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
ENGINE_PY = os.path.dirname(os.path.abspath(__file__)) + "/../kintsugi"

pytestmark = pytest.mark.skipif(
    not PYTEST or not RUFF,
    reason="pytest and/or ruff not installed — set PYTEST/RUFF to run",
)


def _q(cmd):
    return f'"{cmd}"'


def test_the_loop_generates_tests_and_fixes_best_practice_findings(tmp_path):
    """The same fixture as the TS loop-harvest test: best-practice findings
    are repaired mechanically and untested modules get generated smoke
    tests, both through the real verify gate (pytest + ruff re-run)."""
    src = tmp_path / "src"
    src.mkdir()
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "harvest-demo"\nversion = "0.1.0"\n\n'
        '[tool.ruff.lint]\nselect = ["E4", "E7", "E9", "F", "I"]\n',
        encoding="utf-8")
    (src / "app.py").write_text(
        "def look(x):\n"
        "    if type(x) == int:\n"
        "        return x\n"
        "    if len(x) == 0:\n"
        "        return None\n"
        "    return x\n", encoding="utf-8")
    (src / "tax.py").write_text("def calc(amount):\n    return amount * 2\n", encoding="utf-8")

    config = {
        "sourceRoot": str(tmp_path),
        "checks": [
            {"name": "py:test", "command": f"{_q(PYTEST)} -m pytest -q --tb=line",
             "parser": "strict", "severity": "blocker"},
            {"name": "py:lint", "command": f"{RUFF} check . --output-format=concise",
             "parser": "strict", "severity": "minor"},
            {"name": "py:perf", "command": f'{_q(PYTEST)} "{ENGINE_PY}/lint_perf.py" .',
             "parser": "strict", "severity": "minor"},
            {"name": "py:best-practices", "command": f'{_q(PYTEST)} "{ENGINE_PY}/lint_best.py" .',
             "parser": "strict", "severity": "minor"},
            {"name": "py:testgen", "command": f'{_q(PYTEST)} "{ENGINE_PY}/testgen_detect.py" .',
             "parser": "strict", "severity": "minor"},
        ],
        "budget": 2,
        "maxIterations": 15,
        "dryRun": False,
        "allowShared": False,
        "statePath": str(tmp_path / "ledger.json"),
    }

    events = []
    state = Loop(config, lambda e: events.append(e["message"])).run()

    assert state["status"] == "converged", f"status: {state['status']}"

    committed = [a for a in state["attempts"] if a["outcome"] == "committed"]
    rationales = "\n".join(a["patch"]["rationale"] for a in committed)
    assert "using isinstance()" in rationales, "T201 fixed"
    assert "using truthiness instead" in rationales, "T202 fixed"
    assert "generating a smoke test" in rationales, "testgen fixed"

    # The generated files exist, are lint-clean, and pytest ran them.
    assert (src / "test_app.py").exists(), "test_app.py generated"
    assert (src / "test_tax.py").exists(), "test_tax.py generated"
    content = (src / "test_app.py").read_text(encoding="utf-8")
    assert "from app import look" in content

    assert Loop(config, lambda e: None).actionable_remaining() == []
