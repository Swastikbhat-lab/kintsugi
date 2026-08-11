"""Risk scoring + suppression — the prioritization layer over the finding
queue, harvested from CodeGuardian's review model. A faithful mirror of the
TypeScript engine's `src/risk.ts` so both engines order findings identically.

Risk scoring: every finding gets a deterministic 0-10 score from four
dimensions (impact, likelihood, fix cost, blast radius), so the loop targets
the *worst* defect first within a severity band rather than whatever the
tool happened to print first.

Suppression: a small set of context rules drops findings that are almost
always false positives for a *repair* tool — code that is generated (nobody
should patch machine output by hand) and style findings inside test files
(where relaxed rules are conventional). Real test *failures* are never
suppressed: only style codes (T/P/CC) are, never `py:test` results.
"""

import re

_SECURITY = re.compile(r"^B\d{3}$")
_COMPLEXITY = re.compile(r"^CC_[CDEF]$")
_PERF = re.compile(r"^P\d{3}$")
_FIXABLE = re.compile(r"^(T201|T202|T203|T001)$")
_IMPORT = re.compile(r"^(F401|I001|unused_imports)$")
_HARDCODED = re.compile(r"hardcoded (password|secret|key|token)|api[_-]?key|aws[_-]?secret")

_RANK = {"blocker": 0, "major": 1, "minor": 2}


def risk_of(f: dict) -> dict:
    code = f.get("code") or ""
    severity = f.get("severity", "minor")
    message = f"{f['summary']} {f.get('evidence', {}).get('message', '')}".lower()

    # Impact: how bad is it when this defect actually bites.
    if _SECURITY.match(code) or _HARDCODED.search(message):
        impact = 9
    elif severity == "blocker":
        impact = 8
    elif severity == "major":
        impact = 6
    elif _COMPLEXITY.match(code):
        impact = 5
    else:
        impact = 3

    # Likelihood: how often it will actually fire.
    if _SECURITY.match(code):
        likelihood = 9
    elif f["check"].endswith(":test") and re.search(r"assert |== |!= |expected ", message):
        likelihood = 8
    elif _COMPLEXITY.match(code) or _PERF.match(code):
        likelihood = 6
    else:
        likelihood = 3

    # Fix cost: 1 = trivial mechanical edit, 10 = deep rewrite.
    if _COMPLEXITY.match(code):
        fix_cost = 9
    elif _SECURITY.match(code):
        fix_cost = 8
    elif _FIXABLE.match(code):
        fix_cost = 2
    elif _IMPORT.match(code):
        fix_cost = 1
    else:
        fix_cost = 4

    # Scope: how much of the codebase a wrong fix could touch.
    if _SECURITY.match(code):
        scope = 8
    elif severity == "blocker":
        scope = 5
    else:
        scope = 3

    score = impact * 0.4 + likelihood * 0.3 + scope * 0.2 + (10 - fix_cost) * 0.1
    if score >= 8:
        level = "CRITICAL"
    elif score >= 6:
        level = "HIGH"
    elif score >= 4:
        level = "MEDIUM"
    elif score >= 2:
        level = "LOW"
    else:
        level = "MINIMAL"
    return {"score": round(score, 2), "level": level, "impact": impact,
            "likelihood": likelihood, "fixCost": fix_cost, "scope": scope}


def by_risk(a: dict, b: dict) -> int:
    """Worst first: severity band, then risk score descending, then stable
    insertion order (Python's sorted is stable, so ties keep the order the
    observers produced — identical in both engines)."""
    d = _RANK.get(a["severity"], 3) - _RANK.get(b["severity"], 3)
    if d != 0:
        return d
    return -1 if risk_of(a)["score"] > risk_of(b)["score"] else (
        1 if risk_of(a)["score"] < risk_of(b)["score"] else 0)


# ------------------------------------------------------------- suppression

_GENERATED = re.compile(r"generated|_gen\.|migrations/|vendor/", re.IGNORECASE)
_STYLE = re.compile(r"^(T\d{3}|P\d{3}|CC_[A-F])$")
_TEST_FILE = re.compile(r"(?:^|[/\\])test_[^/\\]*\.py$|(?:^|[/\\])[^/\\]*_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$")


def suppress_findings(findings):
    """Split findings into kept / dropped. Dropped ones never enter the
    queue — they are noise a repair loop should not burn an iteration on."""
    kept = []
    dropped = []
    for f in findings:
        file = f.get("file") or ""
        generated = _GENERATED.search(file) is not None
        test_style = _TEST_FILE.search(file) is not None and _STYLE.match(f.get("code") or "") is not None
        (dropped if (generated or test_style) else kept).append(f)
    return {"kept": kept, "dropped": dropped}
