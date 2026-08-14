"""The final report — same buckets and shape as the TypeScript engine:

  committed   — applied, verified, kept. The work.
  reverted    — tried and disproved by the checks (ineffective, regressed).
  escalated   — a real patch existed but touched a shared file, so it was
                reported instead of applied. A decision, not a failure.
  rejected    — had a patch that was neither committed nor escalated.
  quarantined — no candidate patch exists at all; surfaced for a human.
"""

import os


def summarise(state: dict, actionable_remaining):
    attempts = state["attempts"]
    committed = [a for a in attempts if a["outcome"] == "committed"]
    reverted = [a for a in attempts if a["outcome"] in ("ineffective", "regressed")]
    unverifiable = [a for a in attempts if a["outcome"] == "unverifiable"]
    quarantined = [a for a in unverifiable if a["patch"]["id"] == "none"]
    with_patch = [a for a in unverifiable if a["patch"]["id"] != "none"]
    escalated = [a for a in with_patch if a["patch"]["scope"] == "shared"]
    rejected = [a for a in with_patch if a["patch"]["scope"] != "shared"]

    # A finding that survives to the report answers "was there a repair?" from
    # the attempt ledger (live runs) or from the dry survey's stamp — the same
    # vocabulary the TypeScript engine uses.
    repair_by_fingerprint = {}
    for a in committed:
        repair_by_fingerprint[a["fingerprint"]] = "applied"
    for a in reverted:
        repair_by_fingerprint[a["fingerprint"]] = "attempted"
    for a in rejected:
        repair_by_fingerprint[a["fingerprint"]] = "attempted"
    for a in escalated:
        repair_by_fingerprint[a["fingerprint"]] = "escalated"
    for a in quarantined:
        repair_by_fingerprint[a["fingerprint"]] = "none"

    findings = []
    for f in state["findings"]:
        dry = f.get("dryStatus")
        # The dry survey says `patchable`; the report says `proposed`.
        if dry == "patchable":
            dry = "proposed"
        findings.append({**f, "repair": dry or repair_by_fingerprint.get(f["fingerprint"], "none")})

    return {
        "runId": state["id"],
        "status": state["status"],
        "iterations": state["iteration"],
        "committed": committed,
        "reverted": reverted,
        "escalated": escalated,
        "rejected": rejected,
        "quarantined": quarantined,
        "findings": findings,
        "findingsRemaining": len(state["findings"]),
        "actionableRemaining": len(actionable_remaining),
    }


def _rel(source_root: str, f: str) -> str:
    return os.path.relpath(os.path.abspath(f), os.path.abspath(source_root)).replace("\\", "/")


def summary_lines(s: dict, source_root: str):
    lines = [
        f"{s['status'].upper()} after {s['iterations']} iteration(s)",
        f"{len(s['committed'])} committed · {len(s['reverted'])} reverted · "
        f"{len(s['escalated'])} escalated · {len(s['rejected'])} rejected · "
        f"{len(s['quarantined'])} quarantined",
        f"{s['actionableRemaining']} actionable finding(s) remaining",
    ]

    for a in s["committed"]:
        file = a["patch"]["file"]
        lines.append(f"✓ {a['patch']['rationale']}{f'  ({_rel(source_root, file)})' if file else ''}")
    for a in s["escalated"]:
        lines.append(f"↥ ESCALATED {a['patch']['rationale']}  ({_rel(source_root, a['patch']['file'])})")
    for a in s["quarantined"]:
        lines.append(f"? {a['patch']['rationale']}")
    return lines


def _finding_json(f: dict, source_root: str) -> dict:
    """Per-finding detail, key-for-key with the TypeScript engine's report.
    Keys TS omits (undefined) are omitted here too — the parity test asserts
    the two JSON reports are identical."""
    entry = {
        "check": f["check"],
        "severity": f["severity"],
        "summary": f["summary"],
        "repair": f.get("repair", "none"),
    }
    if f.get("file"):
        entry["file"] = _rel(source_root, f["file"])
    if f.get("line"):
        entry["line"] = f["line"]
    if f.get("code"):
        entry["code"] = f["code"]
    return entry


def report_json(s: dict, source_root: str):
    return {
        "runId": s["runId"],
        "status": s["status"],
        "iterations": s["iterations"],
        "committed": [
            {"rationale": a["patch"]["rationale"], "file": _rel(source_root, a["patch"]["file"])}
            for a in s["committed"]
        ],
        "reverted": [
            {"outcome": a["outcome"], "rationale": a["patch"]["rationale"],
             "file": _rel(source_root, a["patch"]["file"])}
            for a in s["reverted"]
        ],
        "escalated": [
            {"rationale": a["patch"]["rationale"], "file": _rel(source_root, a["patch"]["file"])}
            for a in s["escalated"]
        ],
        "quarantined": [{"finding": a["fingerprint"]} for a in s["quarantined"]],
        "findings": [_finding_json(f, source_root) for f in s["findings"]],
        "findingsRemaining": s["findingsRemaining"],
        "actionableRemaining": s["actionableRemaining"],
    }


def exit_code_for(s: dict, quarantined_ok: bool) -> int:
    """0 when nothing actionable remains (or only quarantined, with
    --quarantined-ok)."""
    if s["findingsRemaining"] == 0:
        return 0
    if quarantined_ok and s["actionableRemaining"] == 0:
        return 0
    return 1
