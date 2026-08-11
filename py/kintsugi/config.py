"""Config loading — the Python engine's zero-config discovery.

A repo without a `kintsugi.config.json` gets a sensible default derived from
what is actually in the repo and what its toolchain can run:

  python   — `py:test` (pytest) and `py:lint` (ruff), venv-aware
  go       — `go:test` (go test ./...) and `go:vet` (go vet ./...)
  rust     — `rs:test` (cargo test) and `rs:lint` (cargo clippy)

npm repos are the Node engine's job: the Python engine is the non-Node path.
Detection is marker-first and every toolchain check is gated on a quick
availability probe, so a repo never gets a check whose tool is not installed
— a default check that crashes on arrival would be a broken harness, not a
defect. Anything more specific is written in the config file, which
documents itself by existing.
"""

import json
import os
import re
import subprocess
import sys

PY_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "poetry.lock"]
_REQ_RE = re.compile(r"^requirements.*\.txt$")

# The engine's own Python package — where the stdlib-only scanner scripts
# (perf anti-patterns, best practices, test-generation detection) live.
# Both engines point their checks at these same scripts, so a Python repo
# audited by the Node engine gets byte-identical detection.
_ENGINE_PY = os.path.dirname(os.path.abspath(__file__))
_PY_SCRIPT = lambda n: os.path.join(_ENGINE_PY, n)  # noqa: E731


def probe_command(command: str) -> bool:
    """Availability probe — True when the command exits 0."""
    env = dict(os.environ)
    env.pop("NODE_TEST_CONTEXT", None)
    try:
        proc = subprocess.Popen(
            command,
            shell=True,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return False
    try:
        proc.communicate(timeout=10)
        return proc.returncode == 0
    except subprocess.TimeoutExpired:
        proc.kill()
        return False


def load_config(source_root: str, config_path: str | None = None, probe=probe_command):
    path = os.path.join(source_root, config_path or "kintsugi.config.json")
    file = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                file = json.load(fh)
        except json.JSONDecodeError:
            raise RuntimeError(f"{path} is not valid JSON")

    checks = file.get("checks") if file.get("checks") else default_checks(source_root, probe)

    return {
        "checks": checks,
        "budget": file.get("budget", 2),
        "maxIterations": file.get("maxIterations", 12),
        "allowShared": file.get("allowShared", False),
    }


def default_checks(source_root: str, probe=probe_command):
    """Zero-config defaults for non-Node repos. Language detections are
    cumulative, so a mixed Python + Go repo gets the union."""
    checks = []
    checks.extend(python_checks(source_root, probe))
    checks.extend(go_checks(source_root, probe))
    checks.extend(rust_checks(source_root, probe))
    return checks


# ------------------------------------------------------------- python

def is_python_repo(source_root: str) -> bool:
    if any(os.path.exists(os.path.join(source_root, m)) for m in PY_MARKERS):
        return True
    try:
        names = os.listdir(source_root)
    except OSError:
        return False
    return any(_REQ_RE.match(n) for n in names)


def _venv_python(source_root: str) -> str | None:
    for venv_dir in (".venv", "venv"):
        for rel in ("Scripts/python.exe", "bin/python"):
            # normpath: the rel spells Windows with `/` for POSIX compat, and
            # os.path.join would otherwise leave a mixed-separator path that
            # exists on disk but never matches a probe key (or a shell).
            cand = os.path.normpath(os.path.join(source_root, venv_dir, rel))
            if os.path.exists(cand):
                # Quote: the venv path can contain spaces.
                return f'"{cand}"'
    return None


def python_checks(source_root: str, probe=probe_command):
    if not is_python_repo(source_root):
        return []

    checks = []

    # Prefer the repo's own venv, then the system interpreters. `python3` is
    # probed too: on Windows it is often the Store stub, which fails fast.
    venv = _venv_python(source_root)
    interps = [venv] if venv else ["python", "python3"]

    pytest = None
    for interp in interps:
        if probe(f"{interp} -m pytest --version"):
            pytest = interp
            break
    if pytest:
        checks.append({
            "name": "py:test",
            "command": f"{pytest} -m pytest -q --tb=line",
            "parser": "strict",
            "severity": "blocker",
        })

    ruff = None
    if probe("ruff --version"):
        ruff = "ruff"
    elif pytest and probe(f"{pytest} -m ruff --version"):
        ruff = f"{pytest} -m ruff"
    if ruff:
        checks.append({
            "name": "py:lint",
            "command": f"{ruff} check . --output-format=concise",
            "parser": "strict",
            "severity": "minor",
        })

    # Security and complexity analysis, gated on their tools exactly like
    # ruff. bandit's custom template turns its report into one strict line
    # per issue (`src/creds.py:1:B105:...`); radon always exits 0, so its
    # check carries parseOnExit0 and a parser of its own.
    if probe("bandit --version"):
        # Test files are excluded (bandit's own docs recommend it): B101
        # fires on every `assert` in a test, which is noise, and the
        # test-generation repair produces assert-bearing tests by design.
        checks.append({
            "name": "py:bandit",
            "command": "bandit -q -r . "
                       "-x .venv,venv,node_modules,dist,build,**/test_*.py,test_*.py,"
                       "**/*_test.py,*_test.py,tests "
                       "-f custom --msg-template {relpath}:{line}:{test_id}:{severity}:{msg}",
            "parser": "strict",
            "severity": "major",
        })
    # The engine's own stdlib-only scanners need no third-party tool, just
    # a Python interpreter — so they are always on for Python repos (the
    # script's existence is the only other gate). Test-generation detection
    # is gated on pytest so "generate → run" is always backed by a runner.
    any_py = None
    for interp in interps:
        if probe(f'{interp} -c "import ast"'):
            any_py = interp
            break
    if any_py and probe("radon --version"):
        # radon loads pyproject.toml at import time and crashes on invalid
        # TOML — the wrapper hides a broken config for the run and restores
        # it, so the check works on repos with a stray/malformed
        # pyproject.toml instead of silently reporting nothing.
        checks.append({
            "name": "py:radon",
            "command": f'{any_py} "{_PY_SCRIPT("radon_wrap.py")}"',
            "parser": "radon",
            "severity": "minor",
            "parseOnExit0": True,
        })
    if any_py and os.path.exists(_PY_SCRIPT("lint_perf.py")):
        checks.append({
            "name": "py:perf",
            "command": f'{any_py} "{_PY_SCRIPT("lint_perf.py")}" .',
            "parser": "strict",
            "severity": "minor",
        })
    if any_py and os.path.exists(_PY_SCRIPT("lint_best.py")):
        checks.append({
            "name": "py:best-practices",
            "command": f'{any_py} "{_PY_SCRIPT("lint_best.py")}" .',
            "parser": "strict",
            "severity": "minor",
        })
    if pytest and os.path.exists(_PY_SCRIPT("testgen_detect.py")):
        checks.append({
            "name": "py:testgen",
            "command": f'{pytest} "{_PY_SCRIPT("testgen_detect.py")}" .',
            "parser": "strict",
            "severity": "minor",
        })

    return checks


# ------------------------------------------------------------- go

def go_checks(source_root: str, probe=probe_command):
    if not os.path.exists(os.path.join(source_root, "go.mod")):
        return []
    if not probe("go version"):
        return []
    return [
        {"name": "go:vet", "command": "go vet ./...", "parser": "strict", "severity": "major"},
        {"name": "go:test", "command": "go test ./...", "parser": "strict", "severity": "blocker"},
    ]


# ------------------------------------------------------------- rust

def rust_checks(source_root: str, probe=probe_command):
    if not os.path.exists(os.path.join(source_root, "Cargo.toml")):
        return []
    if not probe("cargo --version"):
        return []
    # `-D warnings` is what makes clippy a *check*: without it the
    # lints are advisory and clippy exits 0. Cargo cold-builds the
    # crate (and its deps) before testing or linting, so these checks
    # carry a longer timeout than the 120s default.
    return [
        {"name": "rs:lint", "command": "cargo clippy -- -D warnings", "parser": "rust", "severity": "minor", "timeoutMs": 300_000},
        {"name": "rs:test", "command": "cargo test --quiet", "parser": "rust", "severity": "blocker", "timeoutMs": 300_000},
    ]
