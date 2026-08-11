import importlib.util
import json

import pytest

from kintsugi.provider import CRITIC_QUESTIONS, ClaudeProvider, MockProvider, create_provider


def _finding(**over):
    base = {
        "fingerprint": "abc", "check": "py:test", "severity": "blocker",
        "summary": "assert 100 == 10", "file": "/repo/src/tax.py", "line": 3,
        "code": None, "evidence": {"message": "assert 100 == 10"},
    }
    base.update(over)
    return base


def _mock_file(tmp_path, entries):
    p = tmp_path / "proposals.json"
    p.write_text(json.dumps(entries), encoding="utf-8")
    return str(p)


def test_mock_matches_by_check_and_contains(tmp_path):
    path = _mock_file(tmp_path, [{
        "match": {"check": "py:test", "contains": "apply_tax"},
        "candidates": [{
            "file": "src/tax.py", "find": "return amount",
            "replace": "return amount * 0.1", "rationale": "right rate",
        }],
    }])
    p = MockProvider(path)

    hit = _finding(check="py:test", summary="assert apply_tax(100) == 10")
    cands = p.propose(hit, "/repo")
    assert len(cands) == 1
    assert cands[0]["find"] == "return amount"
    assert cands[0]["rationale"].endswith("[proposed by mock]")
    assert cands[0]["scope"] == "local"

    miss = _finding(check="py:lint")
    assert p.propose(miss, "/repo") == []
    miss2 = _finding(summary="something else entirely")
    assert p.propose(miss2, "/repo") == []


def test_mock_drops_candidates_outside_the_source_root(tmp_path):
    path = _mock_file(tmp_path, [{
        "match": {"check": "py:test"},
        "candidates": [
            {"file": "src/tax.py", "find": "a", "replace": "b", "rationale": "inside"},
            {"file": "../outside.py", "find": "a", "replace": "b", "rationale": "outside"},
            {"file": "node_modules/x.py", "find": "a", "replace": "b", "rationale": "vendored"},
        ],
    }])
    cands = MockProvider(path).propose(_finding(), "/repo")
    # Platform-safe: abspath on Windows gains a drive prefix.
    assert len(cands) == 1
    assert cands[0]["file"].replace("\\", "/").endswith("/repo/src/tax.py")


def test_mock_unreadable_file_is_a_config_error(tmp_path):
    with pytest.raises(ValueError, match="not readable"):
        MockProvider(str(tmp_path / "missing.json"))


def test_create_provider_resolves_mock_from_config(tmp_path):
    path = _mock_file(tmp_path, [{"match": {}, "candidates": []}])
    provider = create_provider({"llmMock": path})
    assert provider is not None
    assert provider.name == "mock"
    assert create_provider({}) is None or create_provider({}).name == "claude"


def test_claude_provider_absent_without_the_sdk():
    # The anthropic SDK is an optional dependency; with it missing the
    # provider must resolve to None rather than crashing the loop. If the
    # SDK IS installed this assertion has nothing to say — skip it.
    if importlib.util.find_spec("anthropic") is None:
        assert ClaudeProvider.create() is None
    else:
        pytest.skip("anthropic SDK installed — claude provider may resolve")


def test_critic_questions_are_the_three_angles():
    assert len(CRITIC_QUESTIONS) == 3
    assert any("fix" in q for q in CRITIC_QUESTIONS)
    assert any("behaviour" in q or "behavior" in q for q in CRITIC_QUESTIONS)
    assert any("unique" in q for q in CRITIC_QUESTIONS)
