import os
import shutil
import subprocess

import pytest

from kintsugi.loop import Loop


def _find_pytest():
    cands = [os.environ.get("PYTEST"), "python3", "python"]
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
    not PYTEST or not RUFF,
    reason="pytest and/or ruff not installed — set PYTEST/RUFF to run",
)


def _q(cmd):
    return f'"{cmd}"'


def test_the_loop_repairs_a_python_fixture(tmp_path):
    # The same fixture as the TypeScript engine's loop-python test: a stale
    # constant (py:test), an unsorted import block (I001), an unused import
    # (F401). All three must commit through the real verify gate.
    # The isort rule (I001) is not in ruff's default selection before 0.16,
    # so select it explicitly — the test must pass on any ruff version.
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "tax-demo"\nversion = "0.1.0"\n\n'
        '[tool.ruff.lint]\nselect = ["E4", "E7", "E9", "F", "I"]\n',
        encoding="utf-8")
    src = tmp_path / "src"
    src.mkdir()
    (src / "tax.py").write_text(
        "def apply_tax(amount: float) -> float:\n    return amount * 0.08\n", encoding="utf-8")
    (src / "util.py").write_text(
        "import os\n\n\ndef greet(name: str) -> str:\n    return f\"hello {name}\"\n", encoding="utf-8")
    (src / "app.py").write_text(
        "import sys\nimport os\n\n\ndef run() -> str:\n    return f\"{os.name}:{sys.platform}\"\n", encoding="utf-8")
    (tmp_path / "test_tax.py").write_text(
        "from src.tax import apply_tax\n\n\ndef test_apply_tax():\n    assert apply_tax(100) == 10\n", encoding="utf-8")

    config = {
        "sourceRoot": str(tmp_path),
        "checks": [
            {"name": "py:test", "command": f"{_q(PYTEST)} -m pytest -q --tb=line",
             "parser": "strict", "severity": "blocker"},
            {"name": "py:lint", "command": f"{RUFF} check . --output-format=concise",
             "parser": "strict", "severity": "minor"},
        ],
        "budget": 2,
        "maxIterations": 12,
        "dryRun": False,
        "allowShared": False,
        "statePath": str(tmp_path / "ledger.json"),
    }

    events = []
    state = Loop(config, lambda e: events.append(e["message"])).run()

    assert state["status"] == "converged", f"status: {state['status']}"

    committed = [a for a in state["attempts"] if a["outcome"] == "committed"]
    assert len(committed) == 3, (
        f"expected 3 committed, got: {[a['patch']['rationale'] for a in committed]}"
    )

    rationales = "\n".join(a["patch"]["rationale"] for a in committed)
    assert "setting it to 0.1" in rationales, "stale constant repaired"
    assert "sorting it" in rationales, "import block sorted"
    assert "removing the import" in rationales, "unused import removed"

    # Every fix was verified by re-running the real checks.
    assert any("committed — finding cleared with no collateral" in m for m in events)

    # Nothing actionable remains — the fixture is genuinely repaired.
    assert Loop(config, lambda e: None).actionable_remaining() == []
