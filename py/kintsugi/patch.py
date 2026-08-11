"""Applying exact-string edits and handing back the undo.

Every rule in this system produces an edit: a file, a verbatim anchor, and a
replacement. Nothing here rewrites a file wholesale or reformats around the
change — the smallest edit that could clear the finding is the only one
worth verifying, because a large edit makes the verify step unable to
attribute the result.
"""

import os
import re


def apply_edit(edit, source_root: str):
    """Apply one edit; returns a restore callable. Raises on an anchor that
    is missing or a target outside the source root."""
    root = os.path.abspath(source_root)
    file = os.path.abspath(edit["file"])
    rel = os.path.relpath(file, root)
    if rel.startswith("..") or os.path.isabs(rel):
        raise RuntimeError(f"Patch targets {file}, outside source root {root}")

    # newline="" keeps CRLF intact: rules build anchors from split("\n"),
    # so on a CRLF file every anchor line carries a trailing `\r`. A
    # universal-newlines read would strip it and silently lose the match.
    with open(file, "r", encoding="utf-8", newline="") as fh:
        original = fh.read()
    if edit["find"] not in original:
        raise RuntimeError(f"Anchor not found in {rel} — refusing to guess")

    # Match the file's own line endings. Rules are written with "\n", so on
    # a CRLF file every inserted line would arrive bare — leaving the file
    # mixed, and putting line-ending noise in someone's diff on top of the
    # lines they actually wanted.
    crlf = len(re.findall(r"\r\n", original))
    lf = len(re.findall(r"(?<!\r)\n", original))
    replacement = re.sub(r"\r?\n", "\r\n", edit["replace"]) if crlf > lf else edit["replace"]

    # Replace the first occurrence only. A patch that matches in several
    # places is ambiguous, and applying it everywhere is how one fix quietly
    # restyles half a codebase. (newline="" keeps writes byte-exact.)
    updated = original.replace(edit["find"], replacement, 1)
    with open(file, "w", encoding="utf-8", newline="") as fh:
        fh.write(updated)

    def restore():
        with open(file, "w", encoding="utf-8", newline="") as fh:
            fh.write(original)

    return restore


def apply_edits(edits, source_root: str):
    """Apply a patch and its companion edits as one unit; revert in order."""
    restores = [apply_edit(e, source_root) for e in edits]

    def restore():
        for r in reversed(restores):
            r()

    return restore
