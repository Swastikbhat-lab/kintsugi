"""The model path through the Python loop — the mirror of the TypeScript
engine's `--llm-mock` loop test.

The fixture's defect has no mechanical rule (a function body with no
constant), so only the provider can propose a fix. Two flows are proven
end-to-end through the real verify gate:

  - wrong-then-right: the mock proposes a bad guess first (deliberately
    wrong), the checks disprove it and the ledger remembers, then the good
    patch is tried and committed — the loop learns from its miss;
  - critic rejection: a provider whose critics vote drop/drop/keep stops the
    patch before it is ever applied.
"""

import json
import os
import subprocess
import sys

import pytest

from kintsugi.loop import Loop
from kintsugi.provider import CRITIC_QUESTIONS


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


PYTEST = _find_pytest()
pytestmark = pytest.mark.skipif(
    not PYTEST,
    reason="pytest not installed — set PYTEST to run",
)


def _q(cmd):
    return f'"{cmd}"'


def _no_rule_fixture(tmp_path):
    """A defect the mechanical rules cannot reach: `return amount` carries
    no constant, so only a provider can propose the fix."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "tax.py").write_text(
        "def apply_tax(amount: float) -> float:\n    return amount\n",
        encoding="utf-8", newline="\n")
    (tmp_path / "test_tax.py").write_text(
        "from src.tax import apply_tax\n\n\ndef test_apply_tax():\n    assert apply_tax(100) == 10\n",
        encoding="utf-8", newline="\n")
    return src


def _checks(tmp_path):
    return [{
        "name": "py:test",
        "command": f"{_q(PYTEST)} -m pytest -q --tb=line",
        "parser": "strict", "severity": "blocker",
    }]


def _config(tmp_path, **extra):
    cfg = {
        "sourceRoot": str(tmp_path),
        "checks": _checks(tmp_path),
        "budget": 2,
        "maxIterations": 12,
        "dryRun": False,
        "allowShared": False,
        "statePath": str(tmp_path / "ledger.json"),
    }
    cfg.update(extra)
    return cfg


def test_loop_repairs_a_no_rule_defect_via_mock_wrong_then_right(tmp_path):
    src = _no_rule_fixture(tmp_path)
    mock = tmp_path / "proposals.json"
    mock.write_text(json.dumps([{
        "match": {"check": "py:test"},
        "candidates": [
            {
                "file": "src/tax.py", "find": "return amount",
                "replace": "return int(amount)",
                "rationale": "Try an integer pass-through (deliberately wrong — "
                             "the verify gate must reject this and the ledger must "
                             "remember). int(100) == 100 keeps the same pytest "
                             "message, so this is an ineffective retry of the SAME "
                             "finding, not a new collateral defect.",
            },
            {
                "file": "src/tax.py", "find": "return amount",
                "replace": "return amount * 0.1",
                "rationale": "The test asserts 10% on 100, so the rate is 0.1.",
            },
        ],
    }], indent=2), encoding="utf-8")

    events = []
    state = Loop(_config(tmp_path, llmMock=str(mock)), lambda e: events.append(e["message"])).run()

    assert state["status"] == "converged", state["status"]
    # The bad guess was disproved, then the good one committed — one finding,
    # two attempts, the ledger remembering the miss.
    assert len(state["attempts"]) == 2
    assert state["attempts"][0]["outcome"] == "ineffective"
    assert state["attempts"][1]["outcome"] == "committed"
    assert state["attempts"][1]["patch"]["rationale"].endswith("[proposed by mock]")
    assert "No rule covers py:test — asking mock" in events
    assert "committed — finding cleared with no collateral" in events

    # The repaired file is the good patch, verified by a real pytest re-run.
    body = (src / "tax.py").read_text(encoding="utf-8")
    assert "amount * 0.1" in body
    assert "int(amount)" not in body


def test_critic_majority_can_reject_a_patch_before_it_is_applied(tmp_path):
    _no_rule_fixture(tmp_path)
    tax = tmp_path / "src" / "tax.py"

    class RejectingProvider:
        name = "rejector"

        def preflight(self):
            return {"ok": True, "detail": "reachable (test stub)"}

        def propose(self, finding, source_root, context=None, tools=None):
            return [{
                "id": "stub", "file": str(tax),
                "find": "return amount", "replace": "return amount * 0.1",
                "rationale": "stub fix", "scope": "local",
            }]

        def critique(self, patch, finding, question):
            return {"verdict": "drop", "reason": "test: refuse everything"}

    events = []
    state = Loop(
        _config(tmp_path, provider=RejectingProvider()),
        lambda e: events.append(e["message"]),
    ).run()

    # Two of three critics vote drop -> the majority gate rejects before the
    # verify gate; the patch is recorded but never applied.
    # The rejected patch becomes untriable (ledger shouldTry), so the next
    # pass quarantines the finding provider-backed — exactly the TS engine's
    # reject -> quarantine flow. Two attempts total.
    assert len(state["attempts"]) == 2, [a["outcome"] for a in state["attempts"]]
    assert state["attempts"][0]["outcome"] == "unverifiable"
    assert state["attempts"][0]["patch"]["id"] == "stub"   # rejected WITH the patch
    assert state["attempts"][1]["patch"]["id"] == "none"   # then quarantined
    assert "Critic agents rejected the patch — recording and moving on" in events
    assert "No untried patch available for this finding — quarantining for a human" in events
    assert (tax).read_text(encoding="utf-8") == (
        "def apply_tax(amount: float) -> float:\n    return amount\n")


def test_critic_abstention_keeps_and_the_patch_commits(tmp_path):
    src = _no_rule_fixture(tmp_path)

    class KeepingProvider:
        name = "keeper"

        def preflight(self):
            return {"ok": True, "detail": "reachable (test stub)"}

        def propose(self, finding, source_root, context=None, tools=None):
            return [{
                "id": "stub", "file": str(src / "tax.py"),
                "find": "return amount", "replace": "return amount * 0.1",
                "rationale": "stub fix", "scope": "local",
            }]

        def critique(self, patch, finding, question):
            # Abstain entirely — uncertainty alone is "keep", and the
            # deterministic verify gate still runs afterwards.
            return None

    events = []
    state = Loop(_config(tmp_path, provider=KeepingProvider()), lambda e: events.append(e["message"])).run()

    assert state["attempts"][0]["outcome"] == "committed"
    assert "committed — finding cleared with no collateral" in events
    assert "amount * 0.1" in (src / "tax.py").read_text(encoding="utf-8")


def test_critics_are_asked_the_three_questions_in_parallel(tmp_path):
    _no_rule_fixture(tmp_path)
    src = tmp_path / "src"

    class RecordingProvider:
        name = "recorder"

        def __init__(self):
            self.critiques = []

        def preflight(self):
            return {"ok": True, "detail": "reachable (test stub)"}

        def propose(self, finding, source_root, context=None, tools=None):
            return [{
                "id": "stub", "file": str(src / "tax.py"),
                "find": "return amount", "replace": "return amount * 0.1",
                "rationale": "stub fix", "scope": "local",
            }]

        def critique(self, patch, finding, question):
            self.critiques.append(question)
            return {"verdict": "keep", "reason": question}

    provider = RecordingProvider()
    Loop(_config(tmp_path, provider=provider), lambda e: None).run()

    assert sorted(provider.critiques) == sorted(CRITIC_QUESTIONS), f"asked: {provider.critiques}"
