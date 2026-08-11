import os
import shutil
import subprocess

import pytest

from kintsugi.loop import Loop


def _cargo():
    for c in [os.environ.get("CARGO"), "cargo"]:
        if not c:
            continue
        try:
            r = subprocess.run([c, "--version"], capture_output=True, timeout=15, text=True)
            if r.returncode == 0:
                return c
        except Exception:
            continue
    return None


CARGO = _cargo()

pytestmark = pytest.mark.skipif(
    not CARGO,
    reason="cargo not installed — set CARGO to run",
)


def _q(cmd):
    return f'"{cmd}"'


def test_the_loop_repairs_a_rust_fixture(tmp_path):
    # The same fixture as the TypeScript engine's loop-rust test: a stale
    # constant (rs:test, assert_eq!) and an unused `use` import (rs:lint).
    # Both must commit through the real cargo test + clippy verify gate.
    src = tmp_path / "src"
    src.mkdir()
    (tmp_path / "Cargo.toml").write_text(
        '[package]\nname = "tax-demo"\nversion = "0.1.0"\nedition = "2021"\n',
        encoding="utf-8",
    )
    (src / "lib.rs").write_text(
        "use std::fmt;\n\npub fn apply_tax(amount: f64) -> f64 {\n"
        "    amount * 0.08\n"
        "}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n"
        "    #[test]\n    fn test_applies_tax() {\n"
        "        assert_eq!(apply_tax(100.0), 10.0);\n"
        "    }\n}\n",
        encoding="utf-8",
    )

    config = {
        "sourceRoot": str(tmp_path),
        "checks": [
            {"name": "rs:lint", "command": f"{_q(CARGO)} clippy -- -D warnings",
             "parser": "rust", "severity": "minor", "timeoutMs": 300_000},
            {"name": "rs:test", "command": f"{_q(CARGO)} test --quiet",
             "parser": "rust", "severity": "blocker", "timeoutMs": 300_000},
        ],
        "budget": 2,
        "maxIterations": 12,
        "dryRun": False,
        "allowShared": False,
        "statePath": str(tmp_path / "ledger.json"),
    }

    events = []
    state = Loop(config, lambda e: events.append(e["message"])).run()

    assert state["status"] == "converged", f"status: {state['status']}"

    committed = [a for a in state["attempts"] if a["outcome"] == "committed"]
    assert len(committed) == 2, (
        f"expected 2 committed, got: {[a['patch']['rationale'] for a in committed]}"
    )

    rationales = "\n".join(a["patch"]["rationale"] for a in committed)
    assert "setting it to 0.1" in rationales, "stale constant repaired"
    assert "removing the use" in rationales, "unused import removed"

    # Nothing actionable remains — the fixture is genuinely repaired.
    assert Loop(config, lambda e: None).actionable_remaining() == []
