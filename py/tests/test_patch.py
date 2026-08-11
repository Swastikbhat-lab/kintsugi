import pytest

from kintsugi.patch import apply_edit, apply_edits


def _write(path, content):
    # Exact bytes: on Windows write_text translates \n to \r\n, which would
    # defeat LF-shaped anchors (the engine matches raw bytes).
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(content)


def test_applies_the_first_occurrence_only(tmp_path):
    f = tmp_path / "a.py"
    _write(f, "x = 1\nx = 1\n")
    restore = apply_edit({"file": str(f), "find": "x = 1", "replace": "y = 2"}, str(tmp_path))
    assert f.read_text(encoding="utf-8") == "y = 2\nx = 1\n"
    restore()
    assert f.read_text(encoding="utf-8") == "x = 1\nx = 1\n"


def test_refuses_an_anchor_outside_the_source_root(tmp_path):
    outside = tmp_path / ".." / "outside.txt"
    outside.write_text("x", encoding="utf-8")
    with pytest.raises(RuntimeError, match="outside source root"):
        apply_edit({"file": str(outside.resolve()), "find": "x", "replace": "y"}, str(tmp_path))


def test_refuses_a_missing_anchor(tmp_path):
    f = tmp_path / "a.py"
    _write(f, "import os\n")
    with pytest.raises(RuntimeError, match="refusing to guess"):
        apply_edit({"file": str(f), "find": "import sys", "replace": ""}, str(tmp_path))


def test_matches_the_files_crlf_line_endings(tmp_path):
    # A rule operating on a CRLF file builds anchors from split('\n'), so
    # every line carries a trailing `\r` — the anchor must include it, and
    # the replacement is converted to CRLF so the file stays uniform.
    f = tmp_path / "a.py"
    f.write_bytes(b"import os\r\n\r\n\r\ndef g():\r\n    return 'x'\r\n")
    restore = apply_edit(
        {"file": str(f), "find": "import os\r\n", "replace": ""}, str(tmp_path)
    )
    data = f.read_bytes()
    assert b"\r\n" in data
    assert data == b"\r\n\r\ndef g():\r\n    return 'x'\r\n"
    restore()
    assert f.read_bytes() == b"import os\r\n\r\n\r\ndef g():\r\n    return 'x'\r\n"


def test_apply_edits_restores_in_reverse_order(tmp_path):
    f = tmp_path / "a.py"
    _write(f, "import os\n\nx = 1\n")
    restore = apply_edits([
        {"file": str(f), "find": "import os\n", "replace": ""},
        {"file": str(f), "find": "x = 1", "replace": "y = 2"},
    ], str(tmp_path))
    assert "import os" not in f.read_text(encoding="utf-8")
    assert "y = 2" in f.read_text(encoding="utf-8")
    restore()
    assert f.read_text(encoding="utf-8") == "import os\n\nx = 1\n"
