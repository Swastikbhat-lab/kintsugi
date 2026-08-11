"""Headless entry point for the Python engine.

    python -m kintsugi --source <repo> --dry
    python -m kintsugi --source <repo>

The flags mirror the TypeScript engine's CLI (minus the Node-only features:
watch mode and the model proposer). Same report shape, same exit codes.
"""

import json
import os
import sys

from .config import load_config
from .loop import Loop
from .report import exit_code_for, report_json, summarise, summary_lines

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
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    argv = sys.argv[1:] if argv is None else argv
    args = _parse_args(argv)

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
        "statePath": os.path.abspath(args["state"]) if args.get("state") else None,
        "git": "git" in args,
        "branch": args.get("branch"),
        "quarantinedOk": "quarantined-ok" in args,
    }

    def say(e):
        icon = _ICON.get(e["phase"], "·")
        print(f"  {icon} [{e['iteration']}] {e['phase'].ljust(8)} {e['message']}")

    loop = Loop(config, say)
    state = loop.run()
    summary = summarise(state, loop.actionable_remaining())

    if args.get("json"):
        print(json.dumps(report_json(summary, source_root), indent=2))
    else:
        lines = summary_lines(summary, source_root)
        print("\n  " + "\n  ".join(lines) + "\n")

    return exit_code_for(summary, config["quarantinedOk"])
