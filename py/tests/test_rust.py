import os

from kintsugi.config import default_checks
from kintsugi.parsers import parse_rust
from kintsugi.propose import propose_patches

CWD = os.path.abspath(os.path.join(os.path.dirname(__file__), "repo"))


def norm(path):
    return path.replace("\\", "/")


def fake_probe(available):
    def probe(command):
        return any(command.startswith(a) for a in available)
    return probe


def _write(path, text):
    # newline="" keeps LF, so rule anchors built from split("\n") match on
    # every platform (write_text would translate to CRLF on Windows).
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


# ------------------------------------------------------------- parser

def test_rust_parser_reads_a_cargo_test_panic_frame():
    out = "\n".join([
        "running 2 tests",
        "test tests::test_applies_tax ... FAILED",
        "",
        "failures:",
        "",
        "---- tests::test_applies_tax stdout ----",
        "thread 'tests::test_applies_tax' panicked at src/lib.rs:8:5:",
        "assertion `left == right` failed",
        "  left: 8.0,",
        " right: 10",
        "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
        "",
        "failures:",
        "    tests::test_applies_tax",
        "",
        "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
    ])
    f = parse_rust(out, CWD, "rs:test")
    assert len(f) == 1
    assert norm(f[0]["file"]).endswith("/repo/src/lib.rs")
    assert f[0]["line"] == 8
    assert f[0]["summary"] == "assertion `left == right` failed"


def test_rust_parser_pairs_clippy_warnings_with_their_location():
    out = "\n".join([
        "warning: unused import: `std::fmt`",
        " --> src/lib.rs:2:5",
        "  |",
        "2 | use std::fmt;",
        "  |     ^^^^^^^^^",
        "  |",
        "  = help: remove it",
    ])
    f = parse_rust(out, CWD, "rs:lint")
    assert len(f) == 1
    assert f[0]["code"] == "unused_imports"
    assert norm(f[0]["file"]).endswith("/repo/src/lib.rs")
    assert f[0]["line"] == 2
    assert f[0]["evidence"]["col"] == 5


def test_rust_parser_reads_a_denied_lint_printed_as_error():
    out = "\n".join([
        "error: unused import: `std::fmt`",
        " --> src/lib.rs:1:5",
        "  |",
        "1 | use std::fmt;",
        "  |     ^^^^^^^^^",
    ])
    f = parse_rust(out, CWD, "rs:lint")
    assert f[0]["code"] == "unused_imports"
    assert f[0]["line"] == 1


def test_rust_parser_reads_rustc_compile_errors():
    out = "\n".join([
        "error[E0425]: cannot find value `x` in this scope",
        " --> src/lib.rs:5:17",
        "  |",
        "5 |     let y = x;",
        "  |             ^",
    ])
    f = parse_rust(out, CWD, "rs:test")
    assert f[0]["code"] == "E0425"
    assert f[0]["line"] == 5


def test_rust_parser_reads_clippy_short_format():
    f = parse_rust("src/lib.rs:2:5: warning: unused import: `std::fmt`", CWD, "rs:lint")
    assert f[0]["code"] == "unused_imports"
    assert f[0]["line"] == 2


def test_rust_parser_ignores_value_lines_notes_and_noise():
    out = "\n".join([
        "  left: 8.0,",
        " right: 10",
        "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
        "test result: FAILED. 1 passed; 1 failed",
        "  = help: remove it",
    ])
    assert parse_rust(out, CWD, "rs:test") == []


# ------------------------------------------------------------- rules

def test_rs_lint_removes_a_whole_line_unused_use_import(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    lib = src / "lib.rs"
    _write(lib, "use std::fmt;\n\npub fn greet() -> String {\n    \"hi\".to_string()\n}\n")
    finding = {
        "fingerprint": "f",
        "check": "rs:lint",
        "severity": "minor",
        "summary": "unused import: `std::fmt`",
        "file": str(lib),
        "line": 1,
        "code": "unused_imports",
        "evidence": {"message": "unused import: `std::fmt`", "code": "unused_imports"},
    }
    patches = propose_patches(finding, str(tmp_path))
    assert len(patches) == 1
    assert patches[0]["find"] == "use std::fmt;\n"
    assert patches[0]["replace"] == ""


def test_rs_lint_refuses_group_imports(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    lib = src / "lib.rs"
    _write(lib, "use std::collections::{HashMap, HashSet};\n\npub fn g() -> u32 { HashSet::new().len() as u32 }\n")
    finding = {
        "fingerprint": "f",
        "check": "rs:lint",
        "severity": "minor",
        "summary": "unused import: `HashMap`",
        "file": str(lib),
        "line": 1,
        "code": "unused_imports",
        "evidence": {"message": "unused import: `HashMap`", "code": "unused_imports"},
    }
    assert propose_patches(finding, str(tmp_path)) == []


def test_rs_test_a_failing_assert_eq_reveals_the_constant(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    lib = src / "lib.rs"
    _write(lib, (
        "pub fn apply_tax(amount: f64) -> f64 {\n"
        "    amount * 0.08\n"
        "}\n"
        "\n"
        "#[cfg(test)]\n"
        "mod tests {\n"
        "    use super::*;\n"
        "\n"
        "    #[test]\n"
        "    fn test_applies_tax() {\n"
        "        assert_eq!(apply_tax(100.0), 10.0);\n"
        "    }\n"
        "}\n"
    ))
    finding = {
        "fingerprint": "f",
        "check": "rs:test",
        "severity": "blocker",
        "summary": "assertion `left == right` failed",
        "file": str(lib),
        "line": 11,
        "evidence": {"message": "assertion `left == right` failed"},
    }
    patches = propose_patches(finding, str(tmp_path))
    assert len(patches) == 1
    assert patches[0]["find"] == "amount * 0.08"
    assert patches[0]["replace"] == "amount * 0.1"


def test_rs_test_accepts_f64_suffixed_literals_and_refuses_an_unclean_ratio(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    good = src / "good.rs"
    _write(good, (
        "pub fn apply_tax(amount: f64) -> f64 {\n"
        "    amount * 0.08_f64\n"
        "}\n"
        "\n"
        "#[cfg(test)]\n"
        "mod tests {\n"
        "    #[test]\n"
        "    fn t() {\n"
        "        assert_eq!(apply_tax(100.0), 10.0);\n"
        "    }\n"
        "}\n"
    ))
    bad = src / "bad.rs"
    _write(bad, (
        "pub fn split(amount: f64) -> f64 {\n"
        "    amount * 3.0\n"
        "}\n"
        "\n"
        "#[cfg(test)]\n"
        "mod tests {\n"
        "    #[test]\n"
        "    fn t() {\n"
        "        assert_eq!(split(3.0), 10.0);\n"
        "    }\n"
        "}\n"
    ))
    base = {
        "fingerprint": "f",
        "check": "rs:test",
        "severity": "blocker",
        "summary": "assertion `left == right` failed",
        "line": 9,
        "evidence": {"message": "assertion `left == right` failed"},
    }
    patches = propose_patches({**base, "file": str(good)}, str(tmp_path))
    assert len(patches) == 1
    assert patches[0]["replace"] == "amount * 0.1"
    assert propose_patches({**base, "file": str(bad)}, str(tmp_path)) == []


# ------------------------------------------------------------- discovery

def test_rust_repo_detects_clippy_and_cargo(tmp_path):
    (tmp_path / "Cargo.toml").write_text('[package]\nname = "tax"\n', encoding="utf-8")
    checks = default_checks(str(tmp_path), fake_probe(["cargo --version"]))
    assert [c["name"] for c in checks] == ["rs:lint", "rs:test"]
    assert checks[0]["parser"] == "rust"
    assert checks[0]["severity"] == "minor"
    assert "-D warnings" in checks[0]["command"]
    assert checks[1]["severity"] == "blocker"
    assert checks[0]["timeoutMs"] == 300_000


def test_rust_repo_without_cargo_gets_no_checks(tmp_path):
    (tmp_path / "Cargo.toml").write_text('[package]\nname = "tax"\n', encoding="utf-8")
    assert default_checks(str(tmp_path), fake_probe([])) == []


def test_mixed_python_and_rust_repo_gets_the_union(tmp_path):
    (tmp_path / "pyproject.toml").write_text("", encoding="utf-8")
    (tmp_path / "Cargo.toml").write_text('[package]\nname = "tax"\n', encoding="utf-8")
    probe = fake_probe(["python -m pytest --version", "ruff --version", "cargo --version"])
    checks = default_checks(str(tmp_path), probe)
    assert [c["name"] for c in checks] == [
        "py:test", "py:lint", "py:testgen", "rs:lint", "rs:test"]
