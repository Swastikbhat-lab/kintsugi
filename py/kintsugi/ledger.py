"""The ledger is the only reason this system improves rather than just
repeats.

Every repair attempt is recorded against the finding's fingerprint together
with what actually happened to it. On the next encounter with the same
fingerprint the engine consults the ledger before proposing anything:

  - a patch shape that previously committed is tried first
  - a patch shape that previously regressed or was ineffective is skipped

Without this the loop rediscovers the same dead end on every run, which is
the failure mode that makes naive auto-fixers oscillate. The file format is
identical to the TypeScript engine's, so a repo audited by both engines
shares one memory.
"""

import hashlib
import json
import os


def ledger_path_for(source_root: str) -> str:
    """Where a target's ledger lives — keyed by the absolute source root so
    each target keeps its own history. Deliberately *not* inside the target
    repo: dropping an untracked directory into someone's working tree is not
    ours to make."""
    key = hashlib.sha1(os.path.abspath(source_root).encode("utf-8")).hexdigest()[:16]
    return os.path.join(os.path.expanduser("~"), ".kintsugi", "ledgers", f"{key}.json")


class Ledger:
    def __init__(self, path: str):
        self.path = path
        self.attempts = []
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    self.attempts = json.load(fh)
            except Exception:
                # A corrupt ledger must not take the run down. Start clean;
                # the worst case is that we re-learn what we already knew.
                self.attempts = []

    def record(self, attempt: dict) -> None:
        self.attempts.append(attempt)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(self.attempts, fh, indent=2)

    def history(self, fingerprint: str):
        return [a for a in self.attempts if a["fingerprint"] == fingerprint]

    def should_try(self, fingerprint: str, patch: dict) -> bool:
        """A patch is worth trying if we have not already proven it does not
        work. Identity is (file, find, replace) — the same edit, not the
        same wording of the rationale."""
        return not any(
            a["outcome"] != "committed"
            and a["patch"]["file"] == patch["file"]
            and a["patch"]["find"] == patch["find"]
            and a["patch"]["replace"] == patch["replace"]
            for a in self.history(fingerprint)
        )

    def prioritise(self, fingerprint: str, candidates):
        """Order candidate patches by what the ledger has learned. Patches
        whose exact shape has committed before go first; the rest keep their
        order."""
        proven = {
            f"{a['patch']['find']}\u0000{a['patch']['replace']}"
            for a in self.attempts if a["outcome"] == "committed"
        }
        viable = [p for p in candidates if self.should_try(fingerprint, p)]
        key = lambda p: f"{p['find']}\u0000{p['replace']}"
        return (
            [p for p in viable if key(p) in proven]
            + [p for p in viable if key(p) not in proven]
        )

    def is_exhausted(self, finding: dict, limit: int = 3) -> bool:
        """Findings we have repeatedly failed to fix are quarantined rather
        than retried forever — they surface to the human instead of burning
        iterations."""
        tried = self.history(finding["fingerprint"])
        if not tried:
            return False
        # A *provider-backed* dead end with no candidate proves the loop can
        # never fix it. The Python engine has no model, so `provider` is
        # always False here and nothing is permanently exhausted by a
        # rules-only quarantine — exactly like the Node engine without a key.
        if any(a["patch"]["id"] == "none" and a.get("provider") for a in tried):
            return True
        return len(tried) >= limit and not any(a["outcome"] == "committed" for a in tried)

    def all(self):
        return list(self.attempts)
