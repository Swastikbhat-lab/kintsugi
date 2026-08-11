"""The verify gate — the load-bearing phase of the whole loop.

After a patch is applied, every check is re-run. The patch is kept only if
the target finding is gone **and** nothing new appeared. A repair loop
without this step will confidently apply changes that do nothing, and a loop
that skips the collateral check trades one defect for two.

A check that crashes during verification proves nothing, so it cannot count
as success: that outcome is `unverifiable` and the patch is reverted,
because a broken harness must not be able to rubber-stamp an edit.
"""

from concurrent.futures import ThreadPoolExecutor

from .checks import run_check


def verify_patch(checks, source_root: str, baseline: set, target_fingerprint: str):
    with ThreadPoolExecutor(max_workers=max(len(checks), 1)) as ex:
        runs = list(ex.map(lambda c: run_check(c, source_root), checks))

    after = [f for r in runs for f in r["findings"]]
    crashed = any(r["crashed"] for r in runs)

    cleared = not any(f["fingerprint"] == target_fingerprint for f in after)
    collateral = [f for f in after if f["fingerprint"] not in baseline]

    if crashed:
        outcome = "unverifiable"
    elif cleared and not collateral:
        outcome = "committed"
    elif cleared:
        outcome = "regressed"
    else:
        outcome = "ineffective"

    return {"outcome": outcome, "cleared": cleared, "collateral": collateral, "runs": runs}
