"""Watch mode — the Python engine's polling-based port. Same semantics as
the TypeScript engine's WatchSession: debounced bursts, strictly serial
runs, and a run's own writes dropped so the loop never re-triggers itself.
"""

import time

from kintsugi.watch import WatchSession, changed_paths, should_watch, snapshot_tree


def test_should_watch_skips_build_caches_and_vcs(tmp_path):
    assert should_watch("src/tax.py")
    assert should_watch("README.md")
    assert not should_watch("node_modules/x/index.js")
    assert not should_watch("dist/bundle.js")
    assert not should_watch("build/app.js")
    assert not should_watch("__pycache__/tax.cpython-312.pyc")
    assert not should_watch(".git/config")
    assert not should_watch("src/.venv/Lib/site-packages/jwt.py")


def test_snapshot_tree_fingerprints_and_skips(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "tax.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("readme\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "pkg").write_text("junk\n", encoding="utf-8")

    snap = snapshot_tree(str(tmp_path))
    assert "src/tax.py" in snap
    assert "README.md" in snap
    assert not any("node_modules" in p for p in snap)

    # Modify a file (different size so the fingerprint must change even at
    # coarse mtime resolution), add one, delete one.
    (tmp_path / "src" / "tax.py").write_text("x = 22\n", encoding="utf-8")
    (tmp_path / "new.py").write_text("y = 1\n", encoding="utf-8")
    (tmp_path / "README.md").unlink()

    nxt = snapshot_tree(str(tmp_path))
    changed = changed_paths(snap, nxt)
    assert "src/tax.py" in changed
    assert "new.py" in changed
    assert "README.md" in changed
    assert len(changed) == 3


def test_session_debounces_bursts_into_one_run():
    runs = []
    session = WatchSession(
        debounce_ms=80, interval_ms=0,
        on_run=lambda: (runs.append(1), [])[1],
    )
    session.start()
    for _ in range(5):
        session.on_change("src/tax.py")
    now = time.monotonic()
    # Nothing fires while the debounce is still running.
    session.tick(now + 0.01)
    assert runs == []
    # Once quiet for the debounce, exactly one run fires for the burst.
    session.tick(now + 0.2)
    assert len(runs) == 1
    # No pending changes, no interval -> nothing more.
    session.tick(now + 0.5)
    assert len(runs) == 1


def test_session_drops_its_own_echo_but_keeps_human_edits():
    runs = []

    def on_run():
        runs.append(1)
        # The repair loop writes files; the CLI reports them back as the
        # run's own echo. Simulate a human edit landing mid-run too.
        session.on_change("human.py")
        return ["echo.py", "src/tax.py"]

    session = WatchSession(debounce_ms=40, interval_ms=0, on_run=on_run)
    session.on_change("echo.py")
    session.tick(time.monotonic() + 0.2)
    assert len(runs) == 1

    # The echo was dropped, the mid-run human edit is not: a second run
    # fires once its own debounce elapses.
    session.tick(time.monotonic() + 0.3)
    assert len(runs) == 2


def test_interval_fires_even_without_changes():
    runs = []
    session = WatchSession(debounce_ms=40, interval_ms=100, on_run=lambda: (runs.append(1), [])[1])
    session.start()
    # No pending changes at all — the interval alone must fire.
    now = time.monotonic()
    session.tick(now + 0.2)
    assert len(runs) == 1
    session.tick(now + 0.35)
    assert len(runs) == 2


def test_ignored_paths_never_schedule():
    runs = []
    session = WatchSession(debounce_ms=40, interval_ms=0, on_run=lambda: (runs.append(1), [])[1])
    session.on_change("node_modules/x/index.js")
    session.on_change("__pycache__/x.pyc")
    session.tick(time.monotonic() + 0.2)
    assert runs == []


def test_close_stops_further_runs():
    runs = []
    session = WatchSession(debounce_ms=40, interval_ms=0, on_run=lambda: (runs.append(1), [])[1])
    session.on_change("src/tax.py")
    session.close()
    session.tick(time.monotonic() + 0.2)
    assert runs == []
