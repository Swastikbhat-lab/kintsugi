"""Watch mode — keep a repo repaired as it drifts, not just on demand.

The session sits between a change signal and the repair loop. It debounces
bursts into a single run, runs passes strictly serially, and — the part that
makes continuous repair safe — a run's own writes are dropped from the
mid-run change set, so the loop never re-triggers itself. A human's edit
that lands mid-run does.

The TypeScript engine drives this from `fs.watch` events with a polling
fallback; Python's stdlib has no recursive filesystem watcher, so this
port is polling-only: the CLI snapshots the tree on a cadence, feeds
`on_change` for every changed path, and `tick`s the session so a debounced
run fires when the tree has been quiet. Same debounce/serial/echo-drop
semantics, same path-skip rules.
"""

import os
import re
import time

# Paths that never count as drift: build output, caches, VCS, venvs.
_WATCH_SKIP = re.compile(
    r"(^|[/\\])(node_modules|dist|build|__pycache__)([/\\]|$)"
    r"|(^|[/\\])\.[^/\\]+([/\\]|$)",
)


def should_watch(rel: str) -> bool:
    return not _WATCH_SKIP.search(rel.replace("\\", "/"))


class WatchSession:
    """Debounced, serial, self-silencing runs.

    The CLI (or any driver) calls on_change(path) when files change and
    tick(now) on a cadence; the session fires on_run once the tree has been
    quiet for debounce_ms, or every interval_ms regardless. on_run returns
    the files it wrote; they are removed from the pending set so the loop's
    own repairs never re-trigger it.
    """

    def __init__(self, debounce_ms: int, interval_ms: int, on_run, log=None):
        self.debounce = debounce_ms / 1000.0
        self.interval = interval_ms / 1000.0 if interval_ms and interval_ms > 0 else 0.0
        self.on_run = on_run
        self.log = log or (lambda msg: None)
        self.pending = set()
        self.running = False
        self.debounce_until = 0.0
        self.interval_until = 0.0
        self.closed = False

    def on_change(self, path):
        """A file (relative to the root) — or None for the whole tree —
        changed. Ignored paths are not drift: adding nothing means scheduling
        nothing either."""
        if self.closed:
            return
        if path is None or should_watch(path):
            self.pending.add(path if path else "*")
            self.debounce_until = time.monotonic() + self.debounce

    def start(self):
        """Run once shortly after startup, then every interval_ms if set."""
        now = time.monotonic()
        self.debounce_until = now + self.debounce
        if self.interval:
            self.interval_until = now + self.interval

    def close(self):
        self.closed = True

    def tick(self, now: float):
        """Fired by the driver's polling loop. Runs when the debounce has
        elapsed with changes pending, or the interval has elapsed — even with
        no pending changes, so drift that does not touch files is still
        caught."""
        if self.closed or self.running:
            return
        if self.pending and now < self.debounce_until:
            return
        if not self.pending and (not self.interval or now < self.interval_until):
            return
        self._run(now)

    def _run(self, now: float):
        # Everything that accumulated before this run is about to be handled,
        # so it is consumed here. Only changes that arrive *mid-run* can
        # justify another pass — and of those, the files this run itself
        # wrote are the loop's own echo, dropped rather than re-triggering.
        self.pending.clear()
        self.running = True
        touched = []
        try:
            touched = list(self.on_run())
        except Exception as err:
            self.log(f"run failed: {err}")
        finally:
            self.running = False
        for t in touched:
            self.pending.discard(t)
        self.debounce_until = 0.0
        self.interval_until = now + self.interval if self.interval else 0.0
        if self.pending:
            self.log("changes arrived during the run — checking again")
            self.debounce_until = time.monotonic() + self.debounce


# ------------------------------------------------------------- polling

def snapshot_tree(root: str) -> dict:
    """A cheap fingerprint of the tree (path -> mtime:size), used because the
    Python engine has no recursive fs.watch. Build output and caches are
    skipped the same way the session skips them."""
    snap = {}
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune ignored directories in place so os.walk never descends.
        kept = []
        for d in dirnames:
            rel = os.path.relpath(os.path.join(dirpath, d), root).replace("\\", "/")
            if should_watch(rel):
                kept.append(d)
        dirnames[:] = kept
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), root).replace("\\", "/")
            if not should_watch(rel):
                continue
            try:
                st = os.stat(os.path.join(dirpath, name))
                snap[rel] = f"{st.st_mtime_ns}:{st.st_size}"
            except OSError:
                # raced with a writer — skip this file this round
                continue
    return snap


def changed_paths(prev: dict, next_tree: dict):
    """Paths whose fingerprint differs between two snapshots."""
    changed = []
    for path, sig in next_tree.items():
        if prev.get(path) != sig:
            changed.append(path)
    for path in prev:
        if path not in next_tree:
            changed.append(path)
    return changed
