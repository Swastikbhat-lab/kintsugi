import os

from kintsugi.parsers import parse_lines, parse_strict

CWD = os.path.abspath(os.path.join(os.path.dirname(__file__), "repo"))


def norm(path):
    return path.replace("\\", "/")


def test_strict_reads_a_pytest_tb_line_failure():
    out = (
        "_____________________________ test_tax_rate ______________________________\n"
        "\n"
        "E   assert 8 == 10\n"
        "    +  where 8 = apply_tax(100)\n"
        "test_pricing.py:7: assert 8 == 10\n"
        "=========================== short test summary info ===========================\n"
        "FAILED test_pricing.py::test_tax_rate - assert 8 == 10\n"
        "1 failed, 1 passed in 0.05s\n"
    )
    f = parse_strict(out, CWD, "py:test")
    assert len(f) == 1
    assert norm(f[0]["file"]).endswith("/repo/test_pricing.py")
    assert f[0]["line"] == 7
    assert f[0]["summary"] == "assert 8 == 10"


def test_strict_reads_a_go_test_failure_and_skips_fail_banners():
    out = (
        "--- FAIL: TestTaxRate (0.00s)\n"
        "    pricing_test.go:25: expected 10, got 5\n"
        "FAIL\n"
        "FAIL\texample.com/tax\t0.023s\n"
    )
    f = parse_strict(out, CWD, "go:test")
    assert len(f) == 1
    assert norm(f[0]["file"]).endswith("/repo/pricing_test.go")
    assert f[0]["line"] == 25


def test_strict_skips_traceback_frames_and_footers():
    out = (
        "test_pricing.py:7: in test_tax_rate\n"
        "E   assert 8 == 10\n"
        "\n"
        "test_pricing.py:7: AssertionError\n"
        "1 failed in 0.05s\n"
    )
    f = parse_strict(out, CWD, "py:test")
    assert len(f) == 1
    assert f[0]["summary"] == "AssertionError"


def test_strict_reads_ruff_concise_with_column_numbers():
    f = parse_strict("src/foo.py:12:5: F401 [*] 'os' imported but unused", CWD, "py:lint")
    assert len(f) == 1
    assert norm(f[0]["file"]).endswith("/repo/src/foo.py")
    assert f[0]["line"] == 12
    assert f[0]["evidence"]["col"] == 5
    assert f[0]["code"] == "F401"


def test_strict_drops_outside_root_paths_and_non_file_noise():
    out = (
        "C:/Users/me/AppData/Local/site-packages/foo.py:12: boom\n"
        "=== RUN   TestFoo\n"
        "ok  example.com/tax  0.023s\n"
    )
    assert parse_strict(out, CWD, "go:test") == []


def test_strict_reads_a_drive_letter_path_anchored_inside_the_root():
    root = os.path.abspath(CWD).replace("\\", "/")
    f = parse_strict(f"{root}/src/tax.py:4: F401 'os' imported but unused", root, "py:lint")
    assert len(f) == 1
    assert f[0]["line"] == 4


def test_strict_drops_venv_and_site_packages_findings_even_inside_the_root():
    # A real run surfaced phantoms from `.venv/Lib/site-packages/…`: the
    # path passes the outside-root check (it IS under the root) but is not
    # repo code. Venv dirs and package dirs must be skipped anywhere.
    root = os.path.abspath(CWD).replace("\\", "/")
    out = "\n".join([
        f"{root}/.venv/Lib/site-packages/jwt/api_jwt.py:147: InsecureKeyLengthWarning: Key is too short",
        f"{root}/.venv/Lib/site-packages/jwt/api_jwt.py:365: InsecureKeyLengthWarning: Key is too short",
        f"{root}/venv/lib/python3.12/site-packages/x/y.py:9: boom",
        f"{root}/src/foo.py:12:5: F401 'os' imported but unused",
    ])
    f = parse_strict(out, root, "py:lint")
    assert len(f) == 1
    assert f[0]["summary"].startswith("F401")


def test_strict_ignores_pytest_warnings_summary_lines():
    out = (
        "src/tax.py:7: assert 8 == 10\n"
        "==== warnings summary ====\n"
        "src/api.py:12: DeprecationWarning: old API used\n"
        "src/api.py:13: pytest.PytestUnhandledCoroutineWarning: coroutine not awaited\n"
        "src/api.py:14: UserWarning: unknown\n"
    )
    f = parse_strict(out, CWD, "py:test")
    assert len(f) == 1
    assert f[0]["summary"] == "assert 8 == 10"


def test_lines_parser_keeps_bare_messages_but_anchors_files():
    out = (
        "README.md: version 0.1.0 does not match 0.2.0\n"
        "release channel is stale\n"
    )
    f = parse_lines(out, CWD, "version")
    assert len(f) == 2
    assert f[0]["file"] is not None
    assert f[0]["summary"].startswith("version 0.1.0")
    assert f[1]["file"] is None
    assert f[1]["summary"] == "release channel is stale"


def test_fingerprints_are_stable_across_numbers_but_differ_by_defect():
    a = parse_strict("src/a.py:1:1: F401 'os' imported but unused", CWD, "py:lint")
    b = parse_strict("src/a.py:9:1: F401 'os' imported but unused", CWD, "py:lint")
    c = parse_strict("src/a.py:1:1: F401 'sys' imported but unused", CWD, "py:lint")
    assert a[0]["fingerprint"] == b[0]["fingerprint"]
    assert a[0]["fingerprint"] != c[0]["fingerprint"]
