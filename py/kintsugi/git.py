"""Version-control awareness — the conservative port of the TS engine's.

A tool that edits source in place has an obligation the measurement side
does not: the person has to be able to see what it did and undo it without
untangling it from their own work. So this deliberately reads state and
commits only what Kintsugi itself wrote, one patch at a time, on a branch it
made. It never stages someone else's edits, never amends, never pushes, and
never touches history.
"""

import os
import re
import subprocess


def _git(cwd: str, args):
    out = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"git {' '.join(args)} failed")
    return out.stdout.strip()


def inspect(source_root: str):
    try:
        _git(source_root, ["rev-parse", "--is-inside-work-tree"])
    except RuntimeError:
        return {"isRepo": False, "clean": False, "dirty": []}

    status = _git(source_root, ["status", "--porcelain"])
    # Porcelain is `XY <path>`; match the status column instead of counting
    # characters, so a leading space on an unstaged line can't eat the name.
    dirty = []
    for line in (status.split("\n") if status else []):
        m = re.match(r"^\s*\S{1,2}\s+(.+)$", line)
        if m:
            dirty.append(m.group(1).strip())

    branch = None
    try:
        branch = _git(source_root, ["rev-parse", "--abbrev-ref", "HEAD"])
    except RuntimeError:
        pass  # a repo with no commits yet has no HEAD to name

    return {"isRepo": True, "clean": len(dirty) == 0, "branch": branch, "dirty": dirty}


def use_branch(source_root: str, name: str) -> None:
    """Move onto a branch of our own so committed patches never land on
    whatever the person was working on. Reuses the branch if a previous run
    made it."""
    existing = _git(source_root, ["branch", "--list", name])
    if existing:
        _git(source_root, ["checkout", name])
    else:
        _git(source_root, ["checkout", "-b", name])


def commit_file(source_root: str, file: str, subject: str, body: str):
    """Commit exactly one file. Paths are passed after `--` so a filename can
    never be read as a revision, and only this path is staged — a concurrent
    edit elsewhere in the tree is not ours to sweep up."""
    rel = os.path.relpath(os.path.abspath(file), os.path.abspath(source_root)).replace("\\", "/")
    _git(source_root, ["add", "--", rel])

    # Nothing staged means the patch was reverted before we got here.
    staged = _git(source_root, ["diff", "--cached", "--name-only", "--", rel])
    if not staged:
        return None

    _git(source_root, ["commit", "-q", "-m", subject, "-m", body, "--", rel])
    return _git(source_root, ["rev-parse", "--short", "HEAD"])


def log_since(source_root: str, since: str):
    """One-line-per-commit log of what this run produced, for the report."""
    try:
        out = _git(source_root, ["log", "--oneline", f"{since}..HEAD"])
        return out.split("\n") if out else []
    except RuntimeError:
        return []


def head(source_root: str):
    try:
        return _git(source_root, ["rev-parse", "HEAD"])
    except RuntimeError:
        return None
