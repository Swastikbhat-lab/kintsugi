"""The repair loop — the Python engine's deterministic core.

The TypeScript engine deploys an agent graph (concurrent observers, critic
agents, a majority gate) on top of the same semantics; the Python engine is
the sequential core: observe (run every check), diagnose (rank worst-first,
consult the ledger), propose (mechanical rules), verify (apply, re-run the
checks, keep or revert), settle (converge or exhaust).

The tail is serial and must stay that way: two patches applied at once
destroy the verify step's ability to say which one caused what.
"""

import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import cmp_to_key

from .checks import run_check
from .git import commit_file, head, inspect, use_branch
from .imports import build_import_graph, scope_of
from .ledger import Ledger, ledger_path_for
from .patch import apply_edits
from .propose import propose_patches
from .provider import CRITIC_QUESTIONS, create_provider
from .risk import by_risk, suppress_findings
from .tracer import Tracer
from .verify import verify_patch


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Loop:
    def __init__(self, config: dict, emit):
        self.config = config
        self.emit = emit
        self.state = {
            "id": uuid.uuid4().hex[:8],
            "config": config,
            "findings": [],
            "attempts": [],
            "iteration": 0,
            "status": "idle",
            "startedAt": _iso_now(),
        }
        self.ledger = Ledger(config.get("statePath") or ledger_path_for(config["sourceRoot"]))
        self.git_base = None
        self.quarantined_this_run = set()
        self.provider = None
        self.tracer = Tracer.create()

    def say(self, phase: str, message: str) -> None:
        self.emit({
            "runId": self.state["id"],
            "iteration": self.state["iteration"],
            "phase": phase,
            "at": _iso_now(),
            "message": message,
        })

    def actionable_remaining(self):
        return [f for f in self.state["findings"] if not self.ledger.is_exhausted(f)]

    # ------------------------------------------------------------- run

    def run(self):
        self.state["status"] = "running"
        source_root = self.config["sourceRoot"]

        # Before touching anything: if we are going to commit, the tree has
        # to be clean first, or the person cannot tell our edits from theirs.
        if self.config.get("git"):
            repo = inspect(source_root)
            if not repo["isRepo"]:
                raise RuntimeError(f"--git was set but {source_root} is not a git repository")
            if not repo["clean"]:
                dirty = repo["dirty"][:3]
                more = ", …" if len(repo["dirty"]) > 3 else ""
                raise RuntimeError(
                    f"--git needs a clean tree; {len(repo['dirty'])} path(s) have uncommitted "
                    f"changes ({', '.join(dirty)}{more}). Commit or stash them first — otherwise "
                    "Kintsugi's edits and yours end up in the same diff."
                )
            self.git_base = head(source_root)
            branch = self.config.get("branch") or "kintsugi/fixes"
            use_branch(source_root, branch)
            self.say("settle", f"Committing to branch {branch} (was on {repo.get('branch') or 'detached HEAD'})")

        # Establish up front whether the model path works, rather than
        # letting a bad credential masquerade as the model having nothing to
        # suggest. A config may inject a provider object directly (tests);
        # otherwise build one from --llm-mock or the installed SDK.
        self.provider = self.config.get("provider") or create_provider(self.config)
        if self.provider is None:
            self.say("settle", "No model configured — running rules-only (every patch is still verified the same way)")
        elif self.provider.name == "mock":
            self.say("settle", "Model proposer: mock — rules first, replayed proposals for what rules cannot reach")
        else:
            check = self.provider.preflight()
            if check.get("ok"):
                self.say("settle", f"Model proposer {check['detail']} — rules first, model for what rules cannot reach")
            else:
                self.say("settle", f"Model proposer unavailable: {check['detail']}")
                self.say("settle", "Continuing rules-only. Findings with no mechanical rule will be reported, not fixed.")
                self.provider = None

        self.tracer.start_run(self.config)

        checks = self.config["checks"]
        runs = self._run_all(checks, source_root)
        for r in runs:
            self.tracer.span(
                "observe",
                check=r["check"],
                durationMs=r["durationMs"],
                findings=len(r["findings"]),
                crashed=r["crashed"],
            )
        findings = [f for r in runs for f in r["findings"]]
        # Suppression (generated code, test-file style) filters the queue
        # before ranking; risk scoring then orders worst-first within each
        # severity band. Both engines apply the same arithmetic, so the
        # order they converge in is identical.
        filtered = suppress_findings(findings)
        if filtered["dropped"]:
            self.say("observe",
                f"{len(filtered['dropped'])} finding(s) suppressed (generated code or test-file style)")
        findings = sorted(filtered["kept"], key=cmp_to_key(by_risk))
        self.state["findings"] = findings
        baseline = {f["fingerprint"] for f in findings}

        for r in runs:
            self.say("observe", f"{len(r['findings'])} finding(s) ({r['durationMs']}ms)")
        self.say("observe", f"Graph: {len(checks)} observer agent(s) ran concurrently")

        if self.config.get("dryRun"):
            self._dry_survey(findings, source_root)
            self.state["status"] = "converged"
            self.tracer.flush()
            return self.state

        max_iterations = int(self.config.get("maxIterations", 12))
        for i in range(1, max_iterations + 1):
            self.state["iteration"] = i
            target = self._next_target()
            if target is None:
                self.say("diagnose", "Nothing actionable left. Converged.")
                self.state["status"] = "converged"
                self.say("settle", "Converged.")
                self.tracer.flush()
                return self.state

            self.say("diagnose", f"Targeting {target['check']}: {target['summary']}")
            self._process(target, checks, source_root, baseline)

        self.state["status"] = "exhausted"
        self.say("settle", f"Iteration budget ({max_iterations}) reached")
        self.tracer.flush()
        return self.state

    def _run_all(self, checks, source_root):
        with ThreadPoolExecutor(max_workers=max(len(checks), 1)) as ex:
            return list(ex.map(lambda c: run_check(c, source_root), checks))

    def _next_target(self):
        skipped = 0
        for f in self.state["findings"]:
            if f["fingerprint"] in self.quarantined_this_run or self.ledger.is_exhausted(f):
                skipped += 1
                continue
            if skipped:
                self.say("diagnose", f"{skipped} finding(s) already quarantined — left for a human")
            return f
        return None

    # ------------------------------------------------------------- process

    def _process(self, target, checks, source_root, baseline):
        # Rules first: free, instant, and proven on these classes.
        candidates = propose_patches(target, source_root)

        # The model is consulted only for what the rules could not reach.
        if not candidates and self.provider:
            self.say("verify", f"No rule covers {target.get('code') or target['check']} — asking {self.provider.name}")
            try:
                candidates = self.provider.propose(target, source_root)
                self.say("verify", f"{self.provider.name} proposed {len(candidates)} candidate(s)")
                self.tracer.generation(
                    "propose",
                    getattr(self.provider, "last_usage", None),
                    check=target["check"], candidates=len(candidates),
                )
            except Exception as err:
                self.say("verify", f"Model proposer failed: {err}")
                candidates = []

        # Blast radius is decided now, from what the file is — a repair that
        # touches a module other files import changes code the loop is not
        # looking at, and the verify gate cannot catch that.
        graph = build_import_graph(source_root)
        for p in candidates:
            scope, importers = scope_of(graph, p["file"])
            p["scope"] = scope
            p["blastRadius"] = importers

        viable = self.ledger.prioritise(target["fingerprint"], candidates)
        if not viable:
            self.say("verify", "No untried patch available for this finding — quarantining for a human")
            self.quarantined_this_run.add(target["fingerprint"])
            self.record(target, None, "unverifiable", [])
            return

        patch = viable[0]

        # Three critic agents, fresh context, in parallel. Only a provider
        # that can judge is consulted; abstaining is "keep", which is safe
        # because the deterministic verify gate still runs afterwards.
        critique = getattr(self.provider, "critique", None) if self.provider else None
        if critique:
            def ask(question):
                try:
                    return critique(patch, target, question)
                except Exception as err:
                    self.say("verify", f"critic failed: {err}")
                    return None
            with ThreadPoolExecutor(max_workers=len(CRITIC_QUESTIONS)) as ex:
                verdicts = list(ex.map(ask, CRITIC_QUESTIONS))
            drops = sum(1 for v in verdicts if v and v.get("verdict") == "drop")
            if drops:
                self.say("verify", f"{drops}/{len(CRITIC_QUESTIONS)} checks voted drop — "
                          f"{'proceeding' if drops < 2 else 'rejecting'}")
            if drops >= 2:  # majority of three
                self.say("verify", "Critic agents rejected the patch — recording and moving on")
                self.record(target, patch, "unverifiable", [])
                return

        # A shared file is out of scope for an automatic fix, however cleanly
        # it would clear the check. Editing it moves code the loop is not
        # looking at, which is a decision its owner makes — and the verify
        # gate cannot catch this, because the finding really does clear.
        if patch["scope"] == "shared" and not self.config.get("allowShared"):
            rel = os.path.relpath(patch["file"], source_root).replace("\\", "/")
            self.say("verify", f"ESCALATED — {patch['rationale']}")
            self.say("verify",
                f"Not applied: {rel} is imported by {patch['blastRadius']} module(s). "
                "Editing it reaches past the defect. Re-run with --allow-shared to override.")
            self.record(target, patch, "unverifiable", [])
            return
        if patch["scope"] == "shared":
            self.say("verify", f"Shared-file change permitted by --allow-shared ({patch['blastRadius']} importer(s))")

        self.say("verify", f"Patch: {patch['rationale']}")

        restore = apply_edits([patch] + (patch.get("also") or []), source_root)
        outcome = None
        collateral = []
        collateral_detail = []
        runs = None
        try:
            v = verify_patch(checks, source_root, baseline, target["fingerprint"])
            outcome = v["outcome"]
            collateral = [f["fingerprint"] for f in v["collateral"]]
            collateral_detail = [f"{f['check']}: {f['summary']}" for f in v["collateral"]]
            runs = v["runs"]
            self.tracer.span(
                "verify",
                outcome=v["outcome"],
                collateral=len(v["collateral"]),
                durationMs=sum(r["durationMs"] for r in v["runs"]),
            )
        except Exception as err:
            # A failed verification proves nothing, so it cannot count as
            # success. Treat it as a failure and put the file back.
            self.say("verify", f"Verification failed: {err}")
            outcome = "unverifiable"

        if outcome != "committed":
            restore()
            self.say("verify", f"{outcome} — reverted")
            for c in collateral_detail:
                self.say("verify", f"  caused: {c}")
        else:
            self.say("verify", "committed — finding cleared with no collateral")
            # One commit per verified fix, so each can be read, kept, or
            # dropped on its own merits rather than as an all-or-nothing blob.
            if self.config.get("git"):
                try:
                    sha = commit_file(
                        source_root,
                        patch["file"],
                        f"Fix {target['check']}: {target['summary'][:60]}",
                        f"{target['summary']}\n\n{patch['rationale']}\n\n"
                        "Verified by re-running the checks after the change: "
                        "the finding cleared and no new finding appeared.",
                    )
                    if sha:
                        self.say("verify", f"  {sha} committed to git")
                except Exception as err:
                    self.say("verify", f"  git commit failed (the fix is still applied): {err}")

        self.record(target, patch, outcome, collateral)

        # Refresh findings from the verify run so cleared findings disappear
        # and collateral appears — the next target is chosen from reality.
        # The same suppression + risk ordering as the initial observe pass.
        if runs is not None:
            fresh = [f for r in runs for f in r["findings"]]
            filtered = suppress_findings(fresh)
            self.state["findings"] = sorted(filtered["kept"], key=cmp_to_key(by_risk))

    # ------------------------------------------------------------- dry survey

    def _dry_survey(self, findings, source_root):
        """Dry-run survey: report every finding's mechanical answer, write
        nothing."""
        with_patch = 0
        escalated = 0
        none = 0
        graph = build_import_graph(source_root)
        for f in findings:
            candidates = propose_patches(f, source_root)
            if not candidates:
                none += 1
                self.say("diagnose", f"NO PATCH   {f['check']}: {f['summary']}")
                continue
            scope, _ = scope_of(graph, candidates[0]["file"])
            shared = scope == "shared" and not self.config.get("allowShared")
            if shared:
                escalated += 1
                self.say("diagnose", f"ESCALATE   {f['check']}: {f['summary']}")
                rel = os.path.relpath(candidates[0]["file"], source_root).replace("\\", "/")
                self.say("diagnose", f"           → {rel} — shared file, not applied automatically")
            else:
                with_patch += 1
                self.say("diagnose", f"WOULD PATCH {f['check']}: {f['summary']}")
                rel = os.path.relpath(candidates[0]["file"], source_root).replace("\\", "/")
                self.say("diagnose", f"           → {rel} — {candidates[0]['rationale']}")
        self.say("settle",
            f"Dry run: {with_patch} patchable, {escalated} escalated, {none} with no mechanical answer. Nothing written.")

    # ------------------------------------------------------------- record

    def record(self, finding, patch, outcome, collateral):
        attempt = {
            "fingerprint": finding["fingerprint"],
            "patch": patch if patch else {
                "id": "none", "file": "", "find": "", "replace": "",
                "rationale": f"no candidate patch for {finding['check']}: {finding['summary']}",
                "scope": "local",
            },
            "outcome": outcome,
            "at": _iso_now(),
            "collateral": collateral,
            "provider": bool(self.provider),
        }
        self.ledger.record(attempt)
        self.state["attempts"].append(attempt)
