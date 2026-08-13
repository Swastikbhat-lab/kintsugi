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


# ------------------------------------------------------- E711-E714 comparison style

def e7_finding(tmp_path, content, line, code):
    root = make_repo(tmp_path, {"a.py": content})
    message = f"{code} Comparison"
    return propose_patches(finding(
        file=os.path.join(root, "a.py"), line=line, code=code,
        summary=message, evidence={"message": message, "col": 12, "code": code},
    ), root)


def test_e711_rewrites_eq_none_to_is_none(tmp_path):
    pats = e7_finding(tmp_path, "def c(x):\n    return x == None\n", 2, "E711")
    assert pats
    assert pats[0]["find"] == "    return x == None"
    assert pats[0]["replace"] == "    return x is None"


def test_e711_rewrites_neq_none_to_is_not_none(tmp_path):
    pats = e7_finding(tmp_path, "def c(x):\n    return x != None\n", 2, "E711")
    assert pats
    assert pats[0]["replace"] == "    return x is not None"


def test_e711_rewrites_the_negated_form_in_one_edit(tmp_path):
    # `not x == None` half-rewritten would come back as a brand-new E714 on
    # the verify gate's re-run and regress the patch — the rule must land
    # directly on the final form.
    pats = e7_finding(tmp_path, "def c(x):\n    return not x == None\n", 2, "E711")
    assert pats
    assert pats[0]["replace"] == "    return x is not None"


def test_e711_rewrites_every_occurrence_on_the_line(tmp_path):
    # ruff reports `x == None and y == None` as *one* finding (same message,
    # same fingerprint) — a partial rewrite would leave that fingerprint
    # behind and the verify gate would call the patch ineffective.
    pats = e7_finding(tmp_path, "def c(x, y):\n    return x == None and y == None\n", 2, "E711")
    assert pats
    assert pats[0]["replace"] == "    return x is None and y is None"


def test_e711_refuses_chained_comparisons(tmp_path):
    # Rewriting either end of `a == b == None` would corrupt the chain.
    for content in (
        "def c(x, y):\n    return x == None == y\n",
        "def c(a, x):\n    return a == x == None\n",
    ):
        assert e7_finding(tmp_path, content, 2, "E711") == []


def test_e711_handles_attribute_operands(tmp_path):
    pats = e7_finding(
        tmp_path, "class C:\n    def m(self):\n        return self.x == None\n", 3, "E711"
    )
    assert pats
    assert pats[0]["replace"] == "        return self.x is None"


def test_e712_rewrites_bool_comparisons_to_identity(tmp_path):
    for content, want in (
        ("def c(x):\n    return x == True\n", "    return x is True"),
        ("def c(x):\n    return x != False\n", "    return x is not False"),
        ("def c(x):\n    return not x == True\n", "    return x is not True"),
    ):
        pats = e7_finding(tmp_path, content, 2, "E712")
        assert pats, f"expected a patch for {content!r}"
        assert pats[0]["replace"] == want


def test_e713_rewrites_not_in_to_not_in(tmp_path):
    pats = e7_finding(tmp_path, "def c(x, y):\n    return not x in y\n", 2, "E713")
    assert pats
    assert pats[0]["replace"] == "    return x not in y"


def test_e714_rewrites_not_is_to_is_not(tmp_path):
    pats = e7_finding(tmp_path, "def c(x, y):\n    return not x is y\n", 2, "E714")
    assert pats
    assert pats[0]["replace"] == "    return x is not y"


def test_e714_refuses_a_not_operand_rather_than_corrupting_the_line(tmp_path):
    # In `not x is not y` the second `not` is an operator, not the operand.
    assert e7_finding(tmp_path, "def c(x, y):\n    return not x is not y\n", 2, "E714") == []


def test_e7_refuses_a_non_unique_anchor(tmp_path):
    # The same offending line twice in the file: no unique anchor, no patch.
    content = "def c(x):\n    return x == None\n    return x == None\n"
    assert e7_finding(tmp_path, content, 2, "E711") == []


# ------------------------------------------------------- E721 type comparison

def e721_finding(tmp_path, content, line):
    return e7_finding(tmp_path, content, line, "E721")


def test_e721_rewrites_type_eq_to_isinstance(tmp_path):
    pats = e721_finding(tmp_path, "def c(x):\n    return type(x) == int\n", 2)
    assert pats
    assert pats[0]["replace"] == "    return isinstance(x, int)"


def test_e721_rewrites_type_neq_to_not_isinstance(tmp_path):
    pats = e721_finding(tmp_path, "def c(x):\n    return type(x) != int\n", 2)
    assert pats
    assert pats[0]["replace"] == "    return not isinstance(x, int)"


def test_e721_handles_type_on_the_right(tmp_path):
    for content, want in (
        ("def c(x):\n    return int == type(x)\n", "    return isinstance(x, int)"),
        ("def c(x):\n    return int != type(x)\n", "    return not isinstance(x, int)"),
    ):
        pats = e721_finding(tmp_path, content, 2)
        assert pats, f"expected a patch for {content!r}"
        assert pats[0]["replace"] == want


def test_e721_negated_form_lands_directly_on_the_final_edit(tmp_path):
    # `not type(x) == int` must fold to `not isinstance(x, int)` and
    # `not type(x) != int` to `isinstance(x, int)` in one edit — folding
    # the `not` is what makes the `!=` case correct.
    for content, want in (
        ("def c(x):\n    return not type(x) == int\n", "    return not isinstance(x, int)"),
        ("def c(x):\n    return not type(x) != int\n", "    return isinstance(x, int)"),
    ):
        pats = e721_finding(tmp_path, content, 2)
        assert pats, f"expected a patch for {content!r}"
        assert pats[0]["replace"] == want


def test_e721_two_type_calls_become_the_identity_test(tmp_path):
    for content, want in (
        ("def c(x, y):\n    return type(x) == type(y)\n", "    return type(x) is type(y)"),
        ("def c(x, y):\n    return type(x) != type(y)\n", "    return type(x) is not type(y)"),
        ("def c(x, y):\n    return not type(x) == type(y)\n", "    return type(x) is not type(y)"),
        ("def c(x, y):\n    return not type(x) != type(y)\n", "    return type(x) is type(y)"),
    ):
        pats = e721_finding(tmp_path, content, 2)
        assert pats, f"expected a patch for {content!r}"
        assert pats[0]["replace"] == want


def test_e721_handles_dotted_and_subscript_types(tmp_path):
    for content, want in (
        ("def c(x):\n    return type(x) == collections.OrderedDict\n",
         "    return isinstance(x, collections.OrderedDict)"),
        ("def c(x):\n    return type(x) == list[int]\n",
         "    return isinstance(x, list[int])"),
        ("def c(x):\n    return type(x[0]) == int\n",
         "    return isinstance(x[0], int)"),
        ("def c(x):\n    return type(f()) == int\n",
         "    return isinstance(f(), int)"),
    ):
        pats = e721_finding(tmp_path, content, 2)
        assert pats, f"expected a patch for {content!r}"
        assert pats[0]["replace"] == want


def test_e721_rewrites_every_occurrence_on_the_line(tmp_path):
    # ruff reports `type(a) == int and type(b) == str` as two findings with
    # one message, hence one fingerprint — a partial rewrite would leave it
    # behind and the verify gate would call the patch ineffective.
    pats = e721_finding(
        tmp_path, "def c(a, b):\n    return type(a) == int and type(b) == str\n", 2
    )
    assert pats
    assert pats[0]["replace"] == "    return isinstance(a, int) and isinstance(b, str)"


def test_e721_refuses_chained_comparisons(tmp_path):
    for content in (
        "def c(x, y):\n    return type(x) == int == y\n",
        "def c(a, x):\n    return a == type(x) == int\n",
    ):
        assert e721_finding(tmp_path, content, 2) == []


def test_e721_refuses_a_keyword_rhs(tmp_path):
    # `type(x) == None` would become the TypeError isinstance(x, None).
    assert e721_finding(tmp_path, "def c(x):\n    return type(x) == None\n", 2) == []


def test_e721_refuses_a_truncated_subscript_rather_than_corrupting_the_line(tmp_path):
    # A nested bracket would truncate the subscript at the inner `[`; the
    # tail guard refuses the shape instead of emitting a corrupt line.
    assert e721_finding(
        tmp_path, "def c(x):\n    return type(x) == dict[str, list[int]]\n", 2
    ) == []


def test_e721_leaves_the_identity_form_alone(tmp_path):
    # `type(x) is int` is the fixed form (ruff 0.16 no longer flags it) —
    # the rule must not rewrite it.
    assert e721_finding(tmp_path, "def c(x):\n    return type(x) is int\n", 2) == []


def test_e721_refuses_a_mid_identifier_type_anchor(tmp_path):
    # `mytype(x) == int` must not be re-matched as `type(x) == int`.
    assert e721_finding(tmp_path, "def c(x):\n    return mytype(x) == int\n", 2) == []


def test_e721_refuses_a_non_unique_anchor(tmp_path):
    content = "def c(x):\n    return type(x) == int\n    return type(x) == int\n"
    assert e721_finding(tmp_path, content, 2) == []
