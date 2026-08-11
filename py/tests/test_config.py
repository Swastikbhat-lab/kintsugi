import os

from kintsugi.config import default_checks, load_config


def fake_probe(available):
    def probe(command):
        return any(command.startswith(a) for a in available)
    return probe


def test_python_repo_detects_pytest_and_ruff_venv_aware(tmp_path):
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "x"\n', encoding="utf-8")
    venv = tmp_path / ".venv" / "Scripts"
    venv.mkdir(parents=True)
    (venv / "python.exe").write_text("", encoding="utf-8")

    # The probe keys must match exactly what _venv_python emits: the venv
    # interpreter path with native separators, quoted.
    interp = os.path.join(str(tmp_path), ".venv", "Scripts", "python.exe")
    probe = fake_probe([
        f'"{interp}" -m pytest --version',
        f'"{interp}" -m ruff --version',
    ])
    checks = default_checks(str(tmp_path), probe)

    names = [c["name"] for c in checks]
    assert names == ["py:test", "py:lint"]
    assert "pytest" in checks[0]["command"] and "--tb=line" in checks[0]["command"]
    assert checks[0]["severity"] == "blocker"
    assert "ruff" in checks[1]["command"]
    assert checks[1]["severity"] == "minor"


def test_python_repo_without_ruff_still_gets_pytest(tmp_path):
    (tmp_path / "setup.py").write_text("", encoding="utf-8")
    probe = fake_probe(["python -m pytest --version"])
    checks = default_checks(str(tmp_path), probe)
    assert [c["name"] for c in checks] == ["py:test"]


def test_python_repo_with_no_tools_gets_no_checks(tmp_path):
    (tmp_path / "requirements.txt").write_text("", encoding="utf-8")
    checks = default_checks(str(tmp_path), fake_probe([]))
    assert checks == []


def test_go_repo_detects_vet_and_test(tmp_path):
    (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")
    probe = fake_probe(["go version"])
    checks = default_checks(str(tmp_path), probe)
    assert [c["name"] for c in checks] == ["go:vet", "go:test"]
    assert checks[0]["severity"] == "major"
    assert checks[1]["severity"] == "blocker"


def test_mixed_python_and_go_repo_gets_the_union(tmp_path):
    (tmp_path / "pyproject.toml").write_text("", encoding="utf-8")
    (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")
    probe = fake_probe(["python -m pytest --version", "ruff --version", "go version"])
    checks = default_checks(str(tmp_path), probe)
    assert [c["name"] for c in checks] == ["py:test", "py:lint", "go:vet", "go:test"]


def test_config_file_overrides_discovery(tmp_path):
    (tmp_path / "kintsugi.config.json").write_text(
        '{"checks": [{"name": "custom", "command": "python -c \\"print(1)\\"", '
        '"parser": "lines"}], "maxIterations": 3}',
        encoding="utf-8",
    )
    loaded = load_config(str(tmp_path), probe=fake_probe([]))
    assert [c["name"] for c in loaded["checks"]] == ["custom"]
    assert loaded["maxIterations"] == 3


def test_no_checks_for_an_empty_repo(tmp_path):
    assert default_checks(str(tmp_path), fake_probe([])) == []


def test_config_file_can_point_elsewhere(tmp_path, tmp_path_factory):
    other = tmp_path_factory.mktemp("cfg")
    (other / "custom.json").write_text(
        '{"checks": [{"name": "c", "command": "echo x", "parser": "lines"}]}',
        encoding="utf-8",
    )
    loaded = load_config(str(tmp_path), str(other / "custom.json"))
    assert [c["name"] for c in loaded["checks"]] == ["c"]
