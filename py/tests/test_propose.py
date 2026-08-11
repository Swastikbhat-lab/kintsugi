import os

from kintsugi.propose import propose_patches


def make_repo(tmp_path, files):
    # Write exact bytes: the TS tests write LF files, and the rules' anchors
    # are LF-shaped — on Windows write_text would silently translate to CRLF.
    for path, content in files.items():
        full = tmp_path / path
        full.parent.mkdir(parents=True, exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)
    return str(tmp_path)


def finding(**over):
    base = {
        "fingerprint": "f",
        "check": "py:lint",
        "severity": "minor",
        "summary": "s",
        "evidence": {},
    }
    base.update(over)
    return base


def apply_patch(text, p):
    assert p["find"] in text, f"anchor {p['find']!r} not in file"
    return text.replace(p["find"], p["replace"])


# ------------------------------------------------------------- F401

def test_f401_removes_a_whole_line_unused_import_collapsing_a_blank_line(tmp_path):
    root = make_repo(tmp_path, {
        "src/util.py": "import os\n\n\ndef greet(name: str) -> str:\n    return f\"hello {name}\"\n",
    })
    file = os.path.join(root, "src", "util.py")
    patches = propose_patches(finding(
        file=file, line=1, code="F401",
        summary="F401 [*] `os` imported but unused",
        evidence={"message": "F401 [*] `os` imported but unused", "col": 8, "code": "F401"},
    ), root)
    assert patches, "expected a patch"
    p = patches[0]
    assert p["find"] == "import os\n"
    assert p["replace"] == ""
    after = apply_patch(open(file, encoding="utf-8").read(), p)
    assert "import os" not in after
    assert "\n\n\ndef" not in after, "no double blank left behind"


def test_f401_accepts_the_single_quote_spelling_older_ruff_uses(tmp_path):
    root = make_repo(tmp_path, {"u.py": "import os\n\n\ndef g() -> str:\n    return 'x'\n"})
    patches = propose_patches(finding(
        file=os.path.join(root, "u.py"), line=1, code="F401",
        summary="F401 [*] 'os' imported but unused",
        evidence={"message": "F401 [*] 'os' imported but unused", "code": "F401"},
    ), root)
    assert patches


def test_f401_removes_one_name_from_a_multi_name_import(tmp_path):
    root = make_repo(tmp_path, {"u.py": "import os, sys\n\n\ndef g() -> str:\n    return sys.platform\n"})
    patches = propose_patches(finding(
        file=os.path.join(root, "u.py"), line=1, code="F401",
        summary="F401 [*] `os` imported but unused",
        evidence={"message": "F401 [*] `os` imported but unused", "code": "F401"},
    ), root)
    assert patches
    assert patches[0]["replace"] == "import sys"


def test_f401_refuses_a_non_unique_anchor_rather_than_guessing(tmp_path):
    root = make_repo(tmp_path, {
        "u.py": "import os\n# import os\n\n\ndef g() -> str:\n    return \"x\"\n",
    })
    patches = propose_patches(finding(
        file=os.path.join(root, "u.py"), line=1, code="F401",
        summary="F401 [*] `os` imported but unused",
        evidence={"message": "F401 [*] `os` imported but unused", "code": "F401"},
    ), root)
    assert patches == []


# ------------------------------------------------------------- I001

def test_i001_sorts_an_unsorted_stdlib_import_block(tmp_path):
    root = make_repo(tmp_path, {
        "src/app.py": "import sys\nimport os\n\n\ndef run() -> str:\n    return f\"{os.name}:{sys.platform}\"\n",
    })
    file = os.path.join(root, "src", "app.py")
    patches = propose_patches(finding(
        file=file, line=1, code="I001",
        summary="I001 [*] Import block is un-sorted or un-formatted",
        evidence={"message": "I001 [*] Import block is un-sorted or un-formatted", "code": "I001"},
    ), root)
    assert patches
    assert patches[0]["find"] == "import sys\nimport os"
    assert patches[0]["replace"] == "import os\nimport sys"


def test_i001_groups_stdlib_before_third_party_before_first_party(tmp_path):
    root = make_repo(tmp_path, {
        "app.py": "from src import tax\nimport requests\nimport os\n\n\ndef run() -> str:\n    return str(tax)\n",
    })
    patches = propose_patches(finding(
        file=os.path.join(root, "app.py"), line=1, code="I001",
        summary="I001 [*] Import block is un-sorted or un-formatted",
        evidence={"message": "I001 [*] Import block is un-sorted or un-formatted", "code": "I001"},
    ), root)
    assert patches
    assert patches[0]["replace"] == "import os\nimport requests\nfrom src import tax"


def test_i001_refuses_blocks_with_comments_or_parenthesized_imports(tmp_path):
    root = make_repo(tmp_path, {
        "a.py": "import sys\nimport os  # keep\n\n\ndef run() -> str:\n    return \"x\"\n",
        "b.py": "from x import (a, b)\n\n\ndef run() -> str:\n    return str(a)\n",
    })
    a = propose_patches(finding(
        file=os.path.join(root, "a.py"), line=1, code="I001",
        summary="I001 [*] Import block is un-sorted or un-formatted",
        evidence={"message": "I001 [*] Import block is un-sorted or un-formatted", "code": "I001"},
    ), root)
    b = propose_patches(finding(
        file=os.path.join(root, "b.py"), line=1, code="I001",
        summary="I001 [*] Import block is un-sorted or un-formatted",
        evidence={"message": "I001 [*] Import block is un-sorted or un-formatted", "code": "I001"},
    ), root)
    assert a == []
    assert b == []


# ------------------------------------------------------------- stale constant

def test_py_test_a_failing_assertion_reveals_the_right_constant(tmp_path):
    root = make_repo(tmp_path, {
        "src/tax.py": "def apply_tax(amount: float) -> float:\n    return amount * 0.08\n",
        "test_tax.py": "from src.tax import apply_tax\n\n\ndef test_apply_tax():\n    assert apply_tax(100) == 10\n",
    })
    patches = propose_patches(finding(
        check="py:test", severity="blocker",
        file=os.path.join(root, "test_tax.py"), line=5,
        summary="assert 8.0 == 10",
        evidence={"message": "assert 8.0 == 10"},
    ), root)
    assert patches, "expected the constant to be repaired"
    p = patches[0]
    assert p["find"] == "amount * 0.08"
    assert p["replace"] == "amount * 0.1"
    assert p["file"] == os.path.join(root, "src", "tax.py")


def test_py_test_supports_the_mirrored_assertion_assert_want_eq_f_n(tmp_path):
    root = make_repo(tmp_path, {
        "tax.py": "def apply_tax(amount: float) -> float:\n    return amount * 0.08\n",
        "test_tax.py": "from tax import apply_tax\n\n\ndef test():\n    assert 10 == apply_tax(100)\n",
    })
    patches = propose_patches(finding(
        check="py:test", severity="blocker",
        file=os.path.join(root, "test_tax.py"), line=5,
        summary="assert 8.0 == 10",
        evidence={"message": "assert 8.0 == 10"},
    ), root)
    assert patches
    assert patches[0]["replace"] == "amount * 0.1"


def test_py_test_refuses_a_non_clean_ratio_like_10_over_3(tmp_path):
    root = make_repo(tmp_path, {
        "tax.py": "def split(amount: float) -> float:\n    return amount * 3\n",
        "test_tax.py": "from tax import split\n\n\ndef test():\n    assert split(3) == 10\n",
    })
    patches = propose_patches(finding(
        check="py:test", severity="blocker",
        file=os.path.join(root, "test_tax.py"), line=5,
        summary="assert 9 == 10",
        evidence={"message": "assert 9 == 10"},
    ), root)
    assert patches == []


# ------------------------------------------------------------- go

def test_go_test_removes_an_unused_import_spec_from_an_import_block(tmp_path):
    root = make_repo(tmp_path, {
        "main.go": 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\t_ = os.Args\n}\n',
    })
    file = os.path.join(root, "main.go")
    patches = propose_patches(finding(
        check="go:test", severity="blocker",
        file=file, line=4,
        summary='imported and not used: "fmt"',
        evidence={"message": 'imported and not used: "fmt"'},
    ), root)
    assert patches
    assert patches[0]["find"] == '\n\t"fmt"\n'
    assert patches[0]["replace"] == "\n"


def test_go_test_removes_a_whole_line_unused_import(tmp_path):
    root = make_repo(tmp_path, {
        "main.go": 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("x")\n}\n',
    })
    file = os.path.join(root, "main.go")
    patches = propose_patches(finding(
        check="go:test", severity="blocker",
        file=file, line=3,
        summary='imported and not used: "fmt"',
        evidence={"message": 'imported and not used: "fmt"'},
    ), root)
    assert patches
    assert patches[0]["find"] == '\nimport "fmt"\n'
    assert patches[0]["replace"] == "\n"


def test_go_test_equal_t_want_f_n_reveals_the_constant(tmp_path):
    root = make_repo(tmp_path, {
        "tax.go": "package tax\n\nfunc applyTax(amount float64) float64 {\n\treturn amount * 0.08\n}\n",
        "tax_test.go": 'package tax\n\nimport "testing"\n\nfunc TestApplyTax(t *testing.T) {\n\tassert.Equal(t, 10, applyTax(100))\n}\n',
    })
    patches = propose_patches(finding(
        check="go:test", severity="blocker",
        file=os.path.join(root, "tax_test.go"), line=6,
        summary="expected 10, got 5",
        evidence={"message": "expected 10, got 5"},
    ), root)
    assert patches, "expected the constant to be repaired"
    p = patches[0]
    assert p["find"] == "amount * 0.08"
    assert p["replace"] == "amount * 0.1"
    assert p["file"] == os.path.join(root, "tax.go")


def test_go_test_the_plain_if_got_shape_works_too(tmp_path):
    root = make_repo(tmp_path, {
        "tax.go": "package tax\n\nfunc applyTax(amount float64) float64 {\n\treturn amount * 0.08\n}\n",
        "tax_test.go": (
            "package tax\n\nimport \"testing\"\n\n"
            "func TestApplyTax(t *testing.T) {\n"
            "\tif got := applyTax(100); got != 10 {\n"
            '\t\tt.Fatalf("expected %v, got %v", 10, got)\n'
            "\t}\n}\n"
        ),
    })
    patches = propose_patches(finding(
        check="go:test", severity="blocker",
        file=os.path.join(root, "tax_test.go"), line=6,
        summary="expected 10, got 5",
        evidence={"message": "expected 10, got 5"},
    ), root)
    assert patches
    assert patches[0]["replace"] == "amount * 0.1"
