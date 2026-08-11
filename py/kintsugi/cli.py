"""Headless entry point for the Python engine.

    python -m kintsugi --source <repo> --dry
    python -m kintsugi --source <repo>
    python -m kintsugi --source <repo> --llm-mock proposals.json
    python -m kintsugi --source <repo> --watch

The flags mirror the TypeScript engine's CLI. Same report shape, same exit
codes. Watch mode is polling-based (the stdlib has no recursive fs.watch)
but keeps the same debounce / serial-run / echo-suppression semantics.
"""

import json
import os
import sys

from .audit import audit_trace, create_audit_client, print_audit
from .config import load_config
from .loop import Loop
from .report import exit_code_for, report_json, summarise, summary_lines
from .tracer import cost_usd

_USAGE = (
    "No checks discovered. Without a kintsugi.config.json the Python engine detects the\n"
    "repo's toolchain: Python (pytest + ruff, venv-aware), Go (go test + go vet).\n"
    "Nothing matched — write a kintsugi.config.json in the target repo, or pass\n"
    "--checks <a,b,c>.\n\n"
    "Usage: python -m kintsugi --source <repo> [options]\n"
    "\n"
    "  --config <path>      config file (default <source>/kintsugi.config.json)\n"
    "  --checks a,b,c       run only these checks\n"
    "  --budget <n>         repair attempts per finding (default 2)\n"
    "  --max <n>            iteration ceiling (default 12)\n"
    "  --dry                survey every finding, write nothing\n"
    "  --allow-shared       permit patches on files other modules import\n"
    "                       (escalated by default — that is a decision, not a fix)\n"
    "  --state <path>       ledger path (default ~/.kintsugi/ledgers/<hash>.json)\n"
    "  --quarantined-ok     exit 0 when only quarantined findings remain\n"
    "  --git                commit each verified fix on its own branch; requires\n"
    "                       a clean tree so its edits stay yours to review\n"
    "  --branch <name>      branch to use with --git (default kintsugi/fixes)\n"
    "  --json               machine-readable final report on stdout\n"
    "  --list-checks        print the checks that would run, then exit\n"
    "  --llm-mock <path>    replay canned proposals (keyless demo/tests)\n"
    "  --watch              keep repairing as the repo drifts (Ctrl+C to stop)\n"
    "  --interval <secs>    with --watch: also re-check every N seconds\n"
    "  --trace <id>         audit a finished run: read its Langfuse trace and\n"
    "                       print the per-finding cost table (needs LANGFUSE keys)\n"
)

_ICON = {"observe": "◎", "diagnose": "◆", "repair": "✎", "verify": "⟳", "settle": "■"}


def _parse_args(argv):
    args = {}
    i = 0
    while i < len(argv):
        token = argv[i]
        if not token.startswith("--"):
            i += 1
            continue
        key = token[2:]
        nxt = argv[i + 1] if i + 1 < len(argv) else None
        if nxt is not None and not nxt.startswith("--"):
            args[key] = nxt
            i += 1
        else:
            args[key] = "true"
        i += 1
    return args


def main(argv=None):
    # The phase icons are non-ASCII; a redirected Windows console defaults
    # to cp1252 and would crash printing them. UTF-8 everywhere, always.
    # line_buffering keeps watch mode's progress visible when piped (a
    # block-buffered stdout would swallow every line until exit, which for a
    # long-running watch process is never).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except (AttributeError, ValueError):
            pass
    argv = sys.argv[1:] if argv is None else argv
    args = _parse_args(argv)

    # Audit mode: no loop runs, no source needed — read a finished run's
    # trace from Langfuse and print the per-finding cost table.
    if args.get("trace"):
        client = create_audit_client()
        if client is None:
            print("kintsugi: auditing needs LANGFUSE_PUBLIC_KEY/SECRET_KEY and the "
                  "langfuse SDK (pip install langfuse)", file=sys.stderr)
            return 2
        print(print_audit(audit_trace(client, args["trace"]), cost_usd))
        return 0

    source_root = os.path.abspath(args.get("source", "."))
    config_path = os.path.abspath(args["config"]) if args.get("config") else None
    loaded = load_config(source_root, config_path)

    checks = loaded["checks"]
    if args.get("checks"):
        names = {s.strip() for s in args["checks"].split(",") if s.strip()}
        checks = [c for c in checks if c["name"] in names]

    if args.get("list-checks"):
        for c in checks:
            print(f"{c['name']}\t{c['command']}\t({c['parser']})")
        return 0

    if not checks:
        sys.stderr.write(_USAGE)
        return 2

    config = {
        "sourceRoot": source_root,
        "checks": checks,
        "budget": int(args.get("budget") or loaded["budget"]),
        "maxIterations": int(args.get("max") or loaded["maxIterations"]),
        "dryRun": "dry" in args,
        "allowShared": "allow-shared" in args,
        "llmMock": args.get("llm-mock"),
        "statePath": os.path.abspath(args["state"]) if args.get("state") else None,
        "git": "git" in args,
        "branch": args.get("branch"),
        "quarantinedOk": "quarantined-ok" in args,
    }

    def say(e):
        icon = _ICON.get(e["phase"], "·")
        print(f"  {icon} [{e['iteration']}] {e['phase'].ljust(8)} {e['message']}")

    def run_once():
        loop = Loop(config, say)
        state = loop.run()
        summary = summarise(state, loop.actionable_remaining())
        if args.get("json"):
            # Raw UTF-8, not \u escapes: the TS engine's JSON.stringify
            # emits non-ASCII as UTF-8 bytes, and stdout is reconfigured to
            # UTF-8 above — so the machine report is byte-identical across
            # engines.
            print(json.dumps(report_json(summary, source_root), indent=2, ensure_ascii=False))
        else:
            lines = summary_lines(summary, source_root)
            print("\n  " + "\n  ".join(lines) + "\n")
        return exit_code_for(summary, config["quarantinedOk"]), state

    if "watch" not in args:
        return run_once()[0]

    # ---- watch mode: keep the repo repaired as it drifts ---------------
    import time

    from .watch import WatchSession, changed_paths, snapshot_tree

    debounce_ms = 2000
    interval_secs = float(args.get("interval") or 0)
    interval_ms = int(interval_secs * 1000) if interval_secs > 0 else 0

    def on_run():
        # The files this pass wrote are the loop's own echo — the session
        # drops their events so a repair never re-triggers itself.
        _, state = run_once()
        return [a["patch"]["file"] for a in state["attempts"] if a["patch"].get("file")]

    session = WatchSession(
        debounce_ms=debounce_ms,
        interval_ms=interval_ms,
        on_run=on_run,
        log=lambda msg: print(f"  ⌁ {msg}"),
    )
    print(f"  Watching {source_root} — Ctrl+C to stop. A change is checked "
          f"{debounce_ms / 1000}s after it settles.")
    print("  (Python engine watches by polling — no recursive fs.watch in the stdlib)")
    session.start()
    cadence = max(interval_ms or 5000, debounce_ms) / 1000.0
    prev = snapshot_tree(source_root)
    try:
        while True:
            time.sleep(cadence)
            now = time.monotonic()
            next_tree = snapshot_tree(source_root)
            changed = changed_paths(prev, next_tree)
            if changed:
                prev = next_tree
                for p in changed:
                    session.on_change(p)
            session.tick(now)
    except KeyboardInterrupt:
        session.close()
    return 0
