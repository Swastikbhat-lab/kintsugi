import os
import sys
from functools import cmp_to_key

from kintsugi.config import default_checks
from kintsugi.parsers import parse_radon
from kintsugi.patch import apply_edit
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

    restore = apply_edit(p, root)
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
    result = suppress_findings([generated, test_style, failure, product])
    assert result["dropped"] == [generated, test_style]
    assert result["kept"] == [failure, product]


# ------------------------------------------------------------- tracer

def test_cost_usd_uses_reported_token_counts():
    assert cost_usd(1_000_000, 1_000_000) == 30.0
    assert cost_usd(0, 0) == 0.0


def test_tracer_is_inert_without_keys():
    assert Tracer.create().active is False


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
    assert "testgen_detect.py" in checks[6]["command"]


def test_python_repo_without_bandit_or_radon_keeps_the_engine_scanners(tmp_path):
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "x"\n', encoding="utf-8")

    def probe(command):
        return any(command.startswith(a) for a in [
            "python -m pytest --version", "ruff --version", 'python -c "import ast"',
        ])

    checks = default_checks(str(tmp_path), probe)
    assert [c["name"] for c in checks] == [
        "py:test", "py:lint", "py:perf", "py:best-practices", "py:testgen"]
