import json
import os
import shutil
import subprocess
import sys
from functools import cmp_to_key

import pytest

from kintsugi.audit import audit_trace, print_audit
from kintsugi.audit_log import AuditLog
from kintsugi.config import default_checks
from kintsugi.parsers import parse_radon
from kintsugi.patch import apply_edits
from kintsugi.propose import propose_patches
from kintsugi.risk import by_risk, risk_of, suppress_findings
from kintsugi.tracer import Tracer, cost_usd


def make_repo(tmp_path, files):
    for path, content in files.items():
        full = tmp_path / path
        full.parent.mkdir(parents=True, exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)
    return str(tmp_path)


def finding(**over):
    base = {
        "fingerprint": "f",
        "check": "py:best-practices",
        "severity": "minor",
        "summary": "s",
        "evidence": {},
    }
    base.update(over)
    return base


# ------------------------------------------------------------- best practices

def test_t201_rewrites_type_eq_to_isinstance_and_refuses_type_vs_type(tmp_path):
    root = make_repo(tmp_path, {
        "a.py": "def f(x):\n    return type(x) == int\n",
        "b.py": "def g(x, y):\n    return type(x) == type(y)\n",
    })
    patches = propose_patches(finding(
        file=os.path.join(root, "a.py"), line=2, code="T201",
        summary="T201 use isinstance() instead of type()==",
        evidence={"message": "T201 use isinstance() instead of type()==", "code": "T201"},
    ), root)
    assert patches
    assert patches[0]["find"] == "type(x) == int"
    assert patches[0]["replace"] == "isinstance(x, int)"

    none = propose_patches(finding(
        file=os.path.join(root, "b.py"), line=2, code="T201",
        summary="T201 use isinstance() instead of type()==",
        evidence={"message": "T201 use isinstance() instead of type()==", "code": "T201"},
    ), root)
    assert none == []


def test_t202_rewrites_len_comparisons_to_truthiness(tmp_path):
    root = make_repo(tmp_path, {
        "a.py": "def f(x):\n    if len(x) == 0:\n        return None\n    while len(q) > 0:\n        q.pop()\n",
    })
    file = os.path.join(root, "a.py")
    eq = propose_patches(finding(
        file=file, line=2, code="T202",
        summary="T202 use truthiness instead of a len() comparison",
        evidence={"message": "T202 use truthiness instead of a len() comparison", "code": "T202"},
    ), root)
    assert eq[0]["find"] == "len(x) == 0"
    assert eq[0]["replace"] == "not x"
    gt = propose_patches(finding(
        file=file, line=4, code="T202",
        summary="T202 use truthiness instead of a len() comparison",
        evidence={"message": "T202 use truthiness instead of a len() comparison", "code": "T202"},
    ), root)
    assert gt[0]["replace"] == "q"


def test_t203_rewrites_keys_view_to_plain_membership(tmp_path):
    root = make_repo(tmp_path, {
        "a.py": "def f(d):\n    if 'k' in d.keys():\n        return True\n",
    })
    patches = propose_patches(finding(
        file=os.path.join(root, "a.py"), line=2, code="T203",
        summary="T203 use 'in d' instead of 'in d.keys()'",
        evidence={"message": "T203 use 'in d' instead of 'in d.keys()'", "code": "T203"},
    ), root)
    assert patches
    assert patches[0]["replace"] == "'k' in d"


# ------------------------------------------------------------- test generation

def test_t001_generates_a_smoke_test_covering_every_untested_function(tmp_path):
    root = make_repo(tmp_path, {
        "src/tax.py": "def calc(amount):\n    return amount * 2\n\n\ndef net(gross):\n    return gross - 1\n",
    })
    patches = propose_patches(finding(
        check="py:testgen",
        file=os.path.join(root, "src", "tax.py"), line=1, code="T001",
        summary="T001 function 'calc' has no tests",
        evidence={"message": "T001 function 'calc' has no tests", "code": "T001"},
    ), root)
    assert patches
    p = patches[0]
    assert p["create"] is True
    assert p["file"] == os.path.join(root, "src", "test_tax.py")
    assert p["find"] == ""
    # Sorted member names; pytest's basedir rule makes `from tax import`
    # work for a non-package src/ dir.
    assert "from tax import calc, net" in p["replace"]
    assert "def test_calc_is_importable():" in p["replace"]

    restore = apply_edits([p], root)
    assert os.path.exists(p["file"])
    restore()
    assert not os.path.exists(p["file"]), "revert deletes the created file"


def test_t001_uses_the_dotted_spec_for_package_modules(tmp_path):
    root = make_repo(tmp_path, {
        "src/__init__.py": "",
        "src/tax.py": "def calc(amount):\n    return amount * 2\n",
    })
    patches = propose_patches(finding(
        check="py:testgen",
        file=os.path.join(root, "src", "tax.py"), line=1, code="T001",
        summary="T001 function 'calc' has no tests",
        evidence={"message": "T001 function 'calc' has no tests", "code": "T001"},
    ), root)
    assert "from src.tax import calc" in patches[0]["replace"]


def test_t001_refuses_once_a_sibling_test_exists(tmp_path):
    root = make_repo(tmp_path, {
        "tax.py": "def calc(amount):\n    return amount * 2\n",
        "test_tax.py": "from tax import calc\n",
    })
    patches = propose_patches(finding(
        check="py:testgen",
        file=os.path.join(root, "tax.py"), line=1, code="T001",
        summary="T001 function 'calc' has no tests",
        evidence={"message": "T001 function 'calc' has no tests", "code": "T001"},
    ), root)
    assert patches == []


# ------------------------------------------------------------- radon parser

def test_parse_radon_reads_c_plus_functions_and_drops_a_b(tmp_path):
    out = "src\\tax.py\n    F 1:0 apply_tax - C (11)\n    F 5:4 helper - A (3)\nsrc\\ok.py\n    F 1:0 fine - B (6)\n"
    findings = parse_radon(out, str(tmp_path), "py:radon")
    assert len(findings) == 1
    assert findings[0]["code"] == "CC_C"
    assert findings[0]["line"] == 1
    assert findings[0]["summary"] == "cyclomatic complexity C (11): apply_tax"


# ------------------------------------------------------------- risk + suppression

def test_risk_scores_security_above_style_and_orders_worst_first():
    secret_f = finding(code="B105", summary="B105 hardcoded password",
                       evidence={"message": "B105 hardcoded password"})
    secret = risk_of(secret_f)
    assert secret["impact"] == 9 and secret["likelihood"] == 9 and secret["level"] == "CRITICAL"
    unused = risk_of(finding(code="F401", summary="F401 'os' imported but unused",
                             evidence={"message": "F401 'os' imported but unused"}))
    assert unused["fixCost"] == 1
    assert unused["score"] < secret["score"]

    blocker = finding(check="py:test", severity="blocker", summary="assert 8.0 == 10",
                      evidence={"message": "assert 8.0 == 10"})
    todo = finding(code="T101", summary="T101 TODO/FIXME comment found",
                   evidence={"message": "T101 TODO/FIXME comment found"})
    # Sorted with functools.cmp_to_key is stable — ties keep insertion order.
    ordered = sorted([todo, secret_f, blocker], key=cmp_to_key(by_risk))
    assert [f["summary"] for f in ordered] == [
        "assert 8.0 == 10", "B105 hardcoded password", "T101 TODO/FIXME comment found"]


def test_suppression_drops_generated_and_test_style_but_never_test_failures():
    generated = finding(file="/repo/src/app_gen.py", code="F401",
                        summary="F401 'os' imported but unused",
                        evidence={"message": "F401 'os' imported but unused"})
    test_style = finding(file="/repo/tests/test_app.py", code="T102",
                         summary="T102 use logging instead of print",
                         evidence={"message": "T102 use logging instead of print"})
    failure = finding(file="/repo/tests/test_tax.py", check="py:test", severity="blocker",
                      summary="assert 8.0 == 10", evidence={"message": "assert 8.0 == 10"})
    product = finding(file="/repo/src/app.py", code="T201",
                      summary="T201 use isinstance() instead of type()==",
                      evidence={"message": "T201 use isinstance() instead of type()=="})
    # Complexity in a domain-heavy file is expected, not a defect — the
    # suppression family harvested from CodeGuardian's SuppressionEngine.
    domain = finding(file="/repo/src/json_parser.py", code="CC_D",
                     summary="cyclomatic complexity D (15): parse",
                     evidence={"message": "cyclomatic complexity D (15): parse"})
    # …but the same complexity in ordinary business logic stays actionable.
    plain = finding(file="/repo/src/billing.py", code="CC_D",
                    summary="cyclomatic complexity D (15): apply_tax",
                    evidence={"message": "cyclomatic complexity D (15): apply_tax"})
    result = suppress_findings([generated, test_style, failure, product, domain, plain])
    assert result["dropped"] == [generated, test_style, domain]
    assert result["kept"] == [failure, product, plain]


# ------------------------------------------------------------- tracer

def test_cost_usd_uses_reported_token_counts():
    assert cost_usd(1_000_000, 1_000_000) == 30.0
    assert cost_usd(0, 0) == 0.0


def test_tracer_is_inert_without_keys():
    assert Tracer.create().active is False


class _FakeClient:
    """Records what the tracer hands to Langfuse so tests can assert the
    ledger-mirroring shape without a network or credentials."""

    def __init__(self):
        self.spans = []
        self.generations = []

    def trace(self, **kw):
        pass

    def span(self, **kw):
        self.spans.append(kw)

    def generation(self, **kw):
        self.generations.append(kw)

    def flush(self):
        pass


def test_tracer_verify_span_mirrors_the_ledger_attempt_shape():
    fake = _FakeClient()
    tracer = Tracer(fake)
    tracer.start_run({"sourceRoot": "/repo", "checks": [{"name": "py:test"}], "budget": 2})
    tracer.span(
        "verify",
        fingerprint="abc123", check="py:bandit", code="B105",
        patch={"file": "/repo/src/a.py", "find": "PASSWORD = \"x\"",
               "replace": "PASSWORD = os.environ[...]", "rationale": "move to env"},
        outcome="committed", collateral=["py:lint: F821 Undefined name"],
        provider=False, durationMs=120,
    )
    assert len(fake.spans) == 1
    s = fake.spans[0]
    # Same vocabulary the ledger records per attempt — joinable on
    # fingerprint + outcome.
    assert s["input"]["fingerprint"] == "abc123"
    assert s["input"]["outcome"] == "committed"
    assert s["input"]["patch"]["find"] == "PASSWORD = \"x\""
    assert s["input"]["collateral"] == ["py:lint: F821 Undefined name"]
    assert s["input"]["provider"] is False


def test_tracer_generation_carries_real_usage_and_derived_cost():
    fake = _FakeClient()
    tracer = Tracer(fake)
    tracer.start_run({"sourceRoot": "/repo", "checks": [], "budget": 2})
    tracer.generation(
        "propose", {"inputTokens": 1000, "outputTokens": 500},
        check="py:test", candidates=2,
    )
    assert len(fake.generations) == 1
    g = fake.generations[0]
    assert g["usage"] == {"input": 1000, "output": 500, "total": 1500}
    # 1000/1M * $5 + 500/1M * $25 = 0.005 + 0.0125
    assert g["metadata"]["costUsd"] == pytest.approx(0.0175)


def test_tracer_settle_span_carries_the_attempt_history():
    fake = _FakeClient()
    tracer = Tracer(fake)
    tracer.start_run({"sourceRoot": "/repo", "checks": [], "budget": 2})
    tracer.span(
        "settle",
        status="converged", iterations=3,
        attempts=[{"fingerprint": "f1", "outcome": "committed",
                   "patch": {"file": "/repo/src/a.py", "rationale": "r"},
                   "provider": False, "collateral": [], "at": "t"}],
    )
    assert fake.spans[0]["input"]["attempts"][0]["fingerprint"] == "f1"
    assert fake.spans[0]["input"]["attempts"][0]["outcome"] == "committed"


# ------------------------------------------------------------- trace audit

class _FakeObservations:
    def __init__(self, records):
        self.records = records

    def get_many(self, **kw):
        return type("R", (), {"data": self.records})()


class _FakeAuditClient:
    def __init__(self, records):
        self.api = type("A", (), {"observations": _FakeObservations(records)})()


def _trace_records(attempts, generations=()):
    return [
        {"name": "settle", "type": "SPAN", "input": {
            "status": "converged", "iterations": 3, "attempts": attempts}},
        *generations,
    ]


def test_audit_joins_generation_usage_to_attempts_by_fingerprint():
    records = _trace_records(
        attempts=[
            {"fingerprint": "fpA", "check": "py:bandit", "outcome": "committed",
             "patch": {"file": "a.py", "rationale": "move secret to env"},
             "provider": False, "collateral": [], "at": "t"},
            {"fingerprint": "fpB", "check": "py:test", "outcome": "quarantined",
             "patch": {"file": "b.py", "rationale": "no rule"},
             "provider": False, "collateral": [], "at": "t"},
        ],
        generations=[
            {"name": "propose", "type": "GENERATION",
             "input": {"fingerprint": "fpA", "check": "py:bandit", "candidates": 1},
             "usage": {"input": 1000, "output": 500}},
            {"name": "propose", "type": "GENERATION",
             "input": {"fingerprint": "fpA", "check": "py:bandit", "candidates": 2},
             "usage": {"input": 200, "output": 100}},
        ],
    )
    result = audit_trace(_FakeAuditClient(records), "t1")
    assert result["status"] == "ok"
    # Two model calls for fpA accumulate into one row.
    assert result["rows"][0]["fingerprint"] == "fpA"
    assert result["rows"][0]["inputTokens"] == 1200
    assert result["rows"][0]["outputTokens"] == 600
    assert result["rows"][0]["outcome"] == "committed"
    assert result["rows"][1]["inputTokens"] == 0
    assert result["total"] == {"input": 1200, "output": 600}


def test_print_audit_renders_rows_and_total_with_derived_cost():
    records = _trace_records(
        attempts=[{"fingerprint": "fpA", "check": "py:bandit", "outcome": "committed",
                   "patch": {"file": "a.py", "rationale": "move secret to env"},
                   "provider": False, "collateral": [], "at": "t"}],
        generations=[{"name": "propose", "type": "GENERATION",
                      "input": {"fingerprint": "fpA"},
                      "usage": {"input": 1_000_000, "output": 1_000_000}}],
    )
    out = print_audit(audit_trace(_FakeAuditClient(records), "t1"), cost_usd)
    assert "FINGERPRINT" in out and "fpA" in out and "committed" in out
    assert "TOTAL" in out
    assert "30.000000" in out  # 1M in + 1M out at $5/$25 per 1M = $30


def test_audit_reports_no_trace_and_tolerates_missing_settle():
    empty = audit_trace(_FakeAuditClient([]), "missing")
    assert empty["status"] == "no-trace"
    no_settle = audit_trace(_FakeAuditClient([{"name": "observe", "type": "SPAN", "input": {}}]), "t")
    assert no_settle["status"] == "ok" and no_settle["rows"] == []
    assert "no kintsugi attempt history" in print_audit(no_settle, cost_usd)


# ------------------------------------------------------------- audit log (NDJSON)

def test_audit_log_writes_one_line_per_attempt_plus_a_reconciling_summary(tmp_path):
    path = str(tmp_path / "audit.jsonl")
    log = AuditLog(path, cost_usd)
    log.attempt(fingerprint="fp1", outcome="committed", check="py:test",
                rationale="rate 0.1", provider=True, collateral=[],
                input_tokens=1500, output_tokens=700, run_id="run1")
    log.attempt(fingerprint="fp2", outcome="quarantined", check="py:bandit",
                input_tokens=0, output_tokens=0, run_id="run1")
    log.summary(run_id="run1", status="converged", iterations=2,
                committed=1, reverted=0, quarantined=1,
                total_input=1500, total_output=700)
    log.close()

    lines = [json.loads(l) for l in open(path, encoding="utf-8").read().strip().split("\n")]
    assert len(lines) == 3
    assert lines[0]["event"] == "attempt" and lines[0]["fingerprint"] == "fp1"
    assert lines[0]["outcome"] == "committed"
    assert lines[0]["usage"] == {"input": 1500, "output": 700}
    # 1500/1M * $5 + 700/1M * $25 = 0.0075 + 0.0175 = 0.025
    assert lines[0]["costUsd"] == pytest.approx(0.025)
    assert lines[1]["outcome"] == "quarantined"
    assert lines[2]["event"] == "summary" and lines[2]["committed"] == 1
    assert lines[2]["costUsd"] == pytest.approx(0.025)


def test_audit_log_without_a_path_is_a_noop_and_bad_paths_do_not_raise(tmp_path):
    noop = AuditLog(None, cost_usd)
    assert noop.active is False
    noop.attempt(fingerprint="f", outcome="committed")
    noop.summary(run_id="r")
    noop.close()  # must not throw

    bad = AuditLog(str(tmp_path), cost_usd)  # a directory — cannot be opened
    assert bad.active is False
    bad.attempt(fingerprint="f", outcome="committed")
    bad.close()


def test_mock_provider_reports_replayed_usage(tmp_path):
    from kintsugi.provider import MockProvider

    props = tmp_path / "props.json"
    props.write_text(json.dumps([{
        "match": {"check": "py:test", "contains": "assert 100 == 10"},
        "candidates": [{"file": "tax.py", "find": "return amount",
                         "replace": "return amount * 0.1", "rationale": "rate"}],
        "usage": {"inputTokens": 1500, "outputTokens": 700},
    }]), encoding="utf-8")
    root = str(tmp_path / "repo")
    os.makedirs(root)
    open(os.path.join(root, "tax.py"), "w", newline="").write("return amount\n")

    provider = MockProvider(str(props))
    patches = provider.propose({
        "check": "py:test", "summary": "assert 100 == 10",
        "fingerprint": "f", "severity": "minor", "evidence": {},
    }, root)
    assert len(patches) == 1
    assert provider.last_usage == {"inputTokens": 1500, "outputTokens": 700}


# ------------------------------------------------------------- discovery

def test_python_repo_discovers_the_full_toolchain(tmp_path):
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "x"\n', encoding="utf-8")

    def probe(command):
        return any(command.startswith(a) for a in [
            "python -m pytest --version",
            "ruff --version",
            "bandit --version",
            "radon --version",
            'python -c "import ast"',
        ])

    checks = default_checks(str(tmp_path), probe)
    assert [c["name"] for c in checks] == [
        "py:test", "py:lint", "py:bandit", "py:radon", "py:perf", "py:best-practices", "py:testgen",
    ]
    bandit = checks[2]
    assert bandit["severity"] == "major"
    assert "test_" in bandit["command"], "test files must be excluded from bandit"
    radon = checks[3]
    assert radon["parser"] == "radon" and radon.get("parseOnExit0") is True
    assert "radon_wrap.py" in radon["command"], "radon must run through the broken-config wrapper"
    assert "testgen_detect.py" in checks[6]["command"]


# ------------------------------------------------------------- security repair

def test_b105_moves_hardcoded_password_to_os_environ_and_imports_os(tmp_path):
    root = make_repo(tmp_path, {"a.py": "import subprocess\n\nPASSWORD = \"hunter2\"\n"})
    patches = propose_patches(finding(
        check="py:bandit", file=os.path.join(root, "a.py"), line=3, code="B105",
        summary="B105 Possible hardcoded password: 'hunter2'",
        evidence={"message": "B105 Possible hardcoded password: 'hunter2'", "code": "B105"},
    ), root)
    assert len(patches) == 1
    assert patches[0]["replace"].startswith("PASSWORD = os.environ.get(\"PASSWORD\"")
    # The import rides along as a companion edit, not a second candidate.
    assert len(patches[0].get("also", [])) == 1
    assert patches[0]["also"][0]["replace"] == "import os\nimport subprocess"


def test_b105_skips_non_password_assignment_shapes(tmp_path):
    root = make_repo(tmp_path, {"a.py": "PASSWORD = compute()\n"})
    patches = propose_patches(finding(
        check="py:bandit", file=os.path.join(root, "a.py"), line=1, code="B105",
        summary="B105", evidence={"message": "B105", "code": "B105"},
    ), root)
    assert patches == []


def test_b324_adds_usedforsecurity_false_to_weak_hash(tmp_path):
    root = make_repo(tmp_path, {
        "a.py": "def h(x):\n    return hashlib.sha1(x).hexdigest()\n",
        "b.py": "def g(x):\n    return hashlib.sha256(x).hexdigest()\n",
    })
    patches = propose_patches(finding(
        check="py:bandit", file=os.path.join(root, "a.py"), line=2, code="B324",
        summary="B324 Use of weak SHA1 hash",
        evidence={"message": "B324 Use of weak SHA1 hash", "code": "B324"},
    ), root)
    assert len(patches) == 1
    assert patches[0]["replace"] == "    return hashlib.sha1(x, usedforsecurity=False).hexdigest()"
    # sha256 is not a weak hash — no rule.
    assert propose_patches(finding(
        check="py:bandit", file=os.path.join(root, "b.py"), line=2, code="B324",
        summary="B324", evidence={"message": "B324", "code": "B324"},
    ), root) == []


def test_b602_is_deliberately_unfixable_so_it_stays_for_a_human(tmp_path):
    root = make_repo(tmp_path, {"a.py": "def run(cmd):\n    return subprocess.call(cmd, shell=True)\n"})
    patches = propose_patches(finding(
        check="py:bandit", file=os.path.join(root, "a.py"), line=2, code="B602",
        summary="B602 subprocess call with shell=True",
        evidence={"message": "B602 subprocess call with shell=True", "code": "B602"},
    ), root)
    # Dropping the shell makes bandit re-flag the call as B603 (untrusted
    # input) — no mechanical edit clears it, so the rule must not guess.
    assert patches == []


def test_t105_moves_secret_like_values_to_os_environ_but_leaves_benign_keys(tmp_path):
    root = make_repo(tmp_path, {
        "a.py": "API_KEY = \"sk-live-3f9a2c1111111111\"\n",
        "b.py": "CACHE_KEY = \"cart\"\n",
        "c.py": "TOKEN = \"abc12345\"\n",
        "d.py": "API_KEY = \"a-very-long-benign-value\"\n",
    })
    patches = propose_patches(finding(
        check="py:best-practices", file=os.path.join(root, "a.py"), line=1, code="T105",
        summary="T105 hardcoded secret in assignment to API_KEY",
        evidence={"message": "T105 hardcoded secret in assignment to API_KEY", "code": "T105"},
    ), root)
    assert len(patches) == 1
    assert patches[0]["replace"].startswith("API_KEY = os.environ.get(\"API_KEY\"")
    # Short or word-like values are not secrets — no rule fires.
    for f in ("b.py", "c.py", "d.py"):
        assert propose_patches(finding(
            check="py:best-practices", file=os.path.join(root, f), line=1, code="T105",
            summary="T105", evidence={"message": "T105", "code": "T105"},
        ), root) == []


def test_hardcoded_secret_patch_applies_with_its_import_companion(tmp_path):
    root = make_repo(tmp_path, {"a.py": "import subprocess\n\nAPI_KEY = \"sk-live-3f9a2c1111111111\"\n"})
    patches = propose_patches(finding(
        check="py:best-practices", file=os.path.join(root, "a.py"), line=3, code="T105",
        summary="T105", evidence={"message": "T105", "code": "T105"},
    ), root)
    assert len(patches[0].get("also", [])) == 1
    # The loop applies [patch] + patch.also as one unit (apply_edits).
    apply_edits([patches[0]] + (patches[0].get("also") or []), root)
    applied = open(os.path.join(root, "a.py"), encoding="utf-8").read()
    assert "import os" in applied
    assert "os.environ.get(\"API_KEY\"" in applied


# ------------------------------------------------------------- radon wrapper

@pytest.mark.skipif(shutil.which("radon") is None, reason="radon not installed")
def test_radon_wrapper_survives_a_broken_pyproject_toml(tmp_path):
    (tmp_path / "pyproject.toml").write_text("pyproject.toml\n", encoding="utf-8")
    (tmp_path / "tax.py").write_text(
        "def dispatch(a, b, c, d):\n    if a:\n        if b:\n            if c:\n                if d:\n                    return 1\n    return 0\n",
        encoding="utf-8",
    )
    wrapper = os.path.join(os.path.dirname(__file__), "..", "kintsugi", "radon_wrap.py")
    result = subprocess.run([sys.executable, os.path.abspath(wrapper)], cwd=str(tmp_path))
    # Radon ran (exit 0) and the config was restored, byte for byte.
    assert result.returncode == 0
    assert (tmp_path / "pyproject.toml").read_text(encoding="utf-8") == "pyproject.toml\n"
    assert ".kintsugi-hidden" not in [p.name for p in tmp_path.iterdir()]


def test_python_repo_without_bandit_or_radon_keeps_the_engine_scanners(tmp_path):
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "x"\n', encoding="utf-8")

    def probe(command):
        return any(command.startswith(a) for a in [
            "python -m pytest --version", "ruff --version", 'python -c "import ast"',
        ])

    checks = default_checks(str(tmp_path), probe)
    assert [c["name"] for c in checks] == [
        "py:test", "py:lint", "py:perf", "py:best-practices", "py:testgen"]
