"""Stable fingerprints — the key the ledger (and everything else) stores on.

The same defect must produce the same key on every run, and a defect that is
actually gone must produce no key at all. Numbers are normalised to '#':
line numbers, counts and versions change as the codebase moves, and a
fingerprint that changes every run might as well not exist. The check name
and file keep defects from different domains colliding.
"""

import hashlib
import re

_NUM = re.compile(r"\d+")


def fingerprint(check: str, file: str | None, code: str, message: str) -> str:
    key = "|".join([check, file or "", code or "", _NUM.sub("#", message)])
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]
