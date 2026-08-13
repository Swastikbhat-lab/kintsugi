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


# ------------------------------------------------------------- typed I/O retry

# A stand-in for the anthropic SDK: `beta.messages.create` returns one canned
# response per call and records every prompt it was given.
class _FakeRes:
    def __init__(self, text=None, usage=None, stop_reason="end_turn"):
        self.stop_reason = stop_reason
        self.usage = usage
        self.content = [type("_B", (), {"type": "text", "text": text})()] if text is not None else []


class _FakeUsage:
    def __init__(self, input_tokens, output_tokens):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.beta = self
        self.messages = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.responses.pop(0)


def _provider(responses):
    return ClaudeProvider(_FakeClient(responses))


def _tax_file(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    f = src / "tax.py"
    f.write_text("def apply_tax(amount):\n    return amount\n", encoding="utf-8")
    return str(f), str(tmp_path)


_VALID = json.dumps({"patches": [{
    "file": "src/tax.py", "find": "return amount",
    "replace": "return amount * 0.1", "rationale": "right rate",
}]})


def test_propose_retries_on_malformed_json_and_accumulates_usage(tmp_path):
    """Typed-I/O auto-retry (borrowed from NOOA): a reply that is not JSON
    despite a schema is the model's fault, so it is retried with the same
    prompt — and the retry's usage is part of the call's true cost."""
    file, root = _tax_file(tmp_path)
    provider = _provider([
        _FakeRes(text="this is not json", usage=_FakeUsage(10, 5)),
        _FakeRes(text=_VALID, usage=_FakeUsage(20, 7)),
    ])

    cands = provider.propose(_finding(file=file), root)
    assert len(cands) == 1
    assert cands[0]["rationale"].endswith("[proposed by claude]")
    # Both calls' usage is the call's cost — the tracer's numbers.
    assert provider.last_usage == {"inputTokens": 30, "outputTokens": 12}
    assert len(provider.client.calls) == 2


def test_propose_gives_up_after_retry_budget(tmp_path):
    """A model that keeps breaking the contract exhausts its budget and the
    call fails like it always did — the loop catches it and runs rules-only."""
    file, root = _tax_file(tmp_path)
    provider = _provider([_FakeRes(text="nope"), _FakeRes(text="nope")])
    with pytest.raises(RuntimeError, match="not JSON"):
        provider.propose(_finding(file=file), root)
    assert len(provider.client.calls) == 2


def test_propose_corrective_retry_on_anchor_mismatch(tmp_path):
    """When every patch fails the one provable rule — the anchor must exist
    verbatim — one corrective retry names the rejected anchors instead of
    quietly recording a dead end."""
    file, root = _tax_file(tmp_path)
    bad = json.dumps({"patches": [{
        "file": "src/tax.py", "find": "return gross",
        "replace": "x", "rationale": "guessed anchor",
    }]})
    provider = _provider([_FakeRes(text=bad), _FakeRes(text=_VALID)])

    cands = provider.propose(_finding(file=file), root)
    assert len(cands) == 1
    assert cands[0]["find"] == "return amount"
    # The corrective prompt must tell the model why it was rejected.
    assert "return gross" in provider.client.calls[1]["messages"][0]["content"]


def test_propose_empty_list_is_not_retried(tmp_path):
    """An empty patch list is a real answer — retries are for contract
    violations, not for taste, so a model that honestly abstains is charged
    exactly one call."""
    file, root = _tax_file(tmp_path)
    provider = _provider([_FakeRes(text=json.dumps({"patches": []}))])
    assert provider.propose(_finding(file=file), root) == []
    assert len(provider.client.calls) == 1


# ------------------------------------------------------------- proposer context

def test_propose_renders_ledger_and_importer_context(tmp_path):
    """The proposer sees what the harness already knows — the ledger's prior
    attempts at this finding and the file's importer count — through the
    prompt (model-callable context, borrowed from NOOA)."""
    file, root = _tax_file(tmp_path)
    provider = _provider([_FakeRes(text=_VALID)])
    context = {
        "importers": 3,
        "ledger": [{"outcome": "ineffective", "patch": {"find": "old", "replace": "new"}}],
    }

    provider.propose(_finding(file=file), root, context)
    prompt = provider.client.calls[0]["messages"][0]["content"]
    assert "imported by 3 other module" in prompt
    assert "ledger remembers these previous attempts" in prompt
    assert "ineffective" in prompt


def test_propose_without_context_adds_no_block(tmp_path):
    file, root = _tax_file(tmp_path)
    provider = _provider([_FakeRes(text=_VALID)])
    provider.propose(_finding(file=file), root)
    prompt = provider.client.calls[0]["messages"][0]["content"]
    assert "ledger remembers" not in prompt
    assert "imported by" not in prompt


def test_mock_propose_accepts_context(tmp_path):
    """The loop calls every provider with the same signature; the mock
    accepts the context and ignores it."""
    path = _mock_file(tmp_path, [{"match": {"check": "py:test"}, "candidates": []}])
    p = MockProvider(path)
    assert p.propose(_finding(), "/repo", {"importers": 2}) == []


def test_mock_propose_accepts_tools(tmp_path):
    """The mock replays canned proposals, so it accepts the tool runner and
    ignores it — the loop calls every provider the same way."""
    path = _mock_file(tmp_path, [{"match": {"check": "py:test"}, "candidates": []}])
    p = MockProvider(path)
    assert p.propose(_finding(), "/repo", {"importers": 2}, None) == []


# ------------------------------------------------------------- read-only tools

def _tool_repo(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    # newline="" keeps LF, matching the TS tests — otherwise Windows text
    # mode silently writes CRLF and the line-count assertions would see a
    # trailing empty line.
    (src / "tax.py").write_text(
        "def apply_tax(amount):\n    return amount\n", encoding="utf-8", newline="")
    (src / "main.py").write_text(
        "from .tax import apply_tax\n", encoding="utf-8", newline="")
    return str(tmp_path)


def test_tool_runner_reads_files_and_greps_and_lists_importers(tmp_path):
    """The three declared tools answer with bounded text, grounded in the
    real repo: read_file shows the file, grep finds matches with line
    numbers, importers reports who pulls the file in (via the same graph
    the loop already built)."""
    from kintsugi.imports import build_import_graph
    from kintsugi.tools import ToolRunner
    root = _tool_repo(tmp_path)
    runner = ToolRunner(root, build_import_graph(root))

    # A file ending in a newline parses to one trailing empty segment — the
    # runner reports the file's bytes honestly (3 segments, last one empty).
    out = runner.run("read_file", {"path": "src/tax.py"})
    assert out.startswith("src/tax.py (lines 1-3 of 3):")
    assert "def apply_tax" in out

    out = runner.run("read_file", {"path": "src/tax.py", "start": 2})
    assert "return amount" in out and "def apply_tax" not in out

    out = runner.run("grep", {"pattern": "apply_tax"})
    assert "src/main.py:1" in out and "src/tax.py:1" in out

    out = runner.run("importers", {"path": "src/tax.py"})
    assert "1 module(s) import src/tax.py" in out and "src/main.py" in out

    assert "no module imports" in runner.run("importers", {"path": "src/main.py"})


def test_tool_runner_refuses_paths_and_garbage(tmp_path):
    """A read-only tool that can escape the source root is not read-only.
    Every tool resolves paths inside the root, and anything it cannot do is
    reported as an error — the model sees why, not a crash."""
    from kintsugi.tools import ToolRunner
    root = _tool_repo(tmp_path)
    runner = ToolRunner(root)

    assert "error" in runner.run("read_file", {"path": "../secret.py"})
    assert "error" in runner.run("grep", {"pattern": "x", "path": "../.."})
    assert "error" in runner.run("importers", {"path": "../secret.py"})
    assert "unknown tool" in runner.run("frobnicate", {})
    assert "error" in runner.run("grep", {})
    assert "invalid regex" in runner.run("grep", {"pattern": "["})
    # Without a graph the importers tool says so rather than guessing.
    assert "not available" in runner.run("importers", {"path": "src/tax.py"})


def test_propose_uses_read_file_tool_before_answering(tmp_path):
    """The model may call a declared read-only tool before proposing; the
    result comes back in the next prompt, so the model genuinely saw the
    file it then anchors its patch in."""
    from kintsugi.tools import ToolRunner
    file, root = _tax_file(tmp_path)
    tool_req = json.dumps({
        "tool": {"name": "read_file", "args": {"path": "src/tax.py"}}, "patches": [],
    })
    provider = _provider([_FakeRes(text=tool_req), _FakeRes(text=_VALID)])

    cands = provider.propose(_finding(file=file), root, None, ToolRunner(root))
    assert len(cands) == 1
    assert cands[0]["find"] == "return amount"
    # The tool result was fed back into the next call's prompt.
    assert "def apply_tax" in provider.client.calls[1]["messages"][0]["content"]
    assert len(provider.client.calls) == 2


def test_propose_tool_budget_is_bounded(tmp_path):
    """A model that keeps calling tools is bounded: 6 execute, the 7th hits
    the cap, and one final nudge can still produce the answer. A curious
    model cannot balloon the prompt."""
    from kintsugi.tools import ToolRunner
    file, root = _tax_file(tmp_path)
    tool_req = json.dumps({
        "tool": {"name": "grep", "args": {"pattern": "def "}}, "patches": [],
    })
    provider = _provider(
        [_FakeRes(text=tool_req)] * 7 + [_FakeRes(text=_VALID)])

    cands = provider.propose(_finding(file=file), root, None, ToolRunner(root))
    assert len(cands) == 1
    assert len(provider.client.calls) == 8


def test_propose_reports_an_unknown_tool_to_the_model(tmp_path):
    """An unknown tool name is an error the model can read, not a crash:
    the next prompt carries the refusal so the model can recover."""
    from kintsugi.tools import ToolRunner
    file, root = _tax_file(tmp_path)
    bad = json.dumps({"tool": {"name": "rm", "args": {}}, "patches": []})
    provider = _provider([_FakeRes(text=bad), _FakeRes(text=_VALID)])

    cands = provider.propose(_finding(file=file), root, None, ToolRunner(root))
    assert len(cands) == 1
    assert "unknown tool" in provider.client.calls[1]["messages"][0]["content"]
