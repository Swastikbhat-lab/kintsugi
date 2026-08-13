"""Read-only tools the model proposer may call.

The model never executes code and never touches live objects. It can only
ask the harness to read files, grep, and list importers, and the answers
come back as bounded text in the prompt. This is the safe half of NOOA's
pass-by-reference (see docs/NOOA.md): the *effect* of context navigation
through declared, inspectable tools — not the mechanism of letting the
model run code against the repo.

Every result is capped so the prompt cannot balloon; a tool that reads the
whole repo is a tool that defeats the point of a bounded context. Paths are
resolved inside the source root and refused if they escape it.

Mirrors `src/tools.ts` in the TypeScript engine.
"""

import glob
import os
import re

# Result caps, mirrored from src/tools.ts.
MAX_READ_LINES = 400
MAX_READ_CHARS = 20_000
MAX_GREP_MATCHES = 40
MAX_IMPORTERS = 20

_SKIP = re.compile(r"(^|[\\/])(node_modules|dist|build|\.git|\.venv)([\\/]|$)")
_GREP_EXTS = (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".md")


class ToolRunner:
    """Executes one declared tool call against the repo, returning text.

    `graph` is the import graph the loop already built (blast radius); when
    absent, the `importers` tool reports that it is unavailable rather than
    guessing.
    """

    def __init__(self, source_root: str, graph: dict | None = None):
        self.source_root = os.path.abspath(source_root)
        self.graph = graph

    def run(self, name: str, args: dict) -> str:
        args = args or {}
        if name == "read_file":
            return self._read_file(args)
        if name == "grep":
            return self._grep(args)
        if name == "importers":
            return self._importers(args)
        return f"error: unknown tool {name!r} — use one of: read_file, grep, importers"

    def _resolve(self, path) -> str | None:
        """Resolve a model-supplied relative path inside the source root."""
        if not isinstance(path, str) or not path:
            return None
        abs_path = os.path.abspath(os.path.join(self.source_root, path))
        rel = os.path.relpath(abs_path, self.source_root).replace("\\", "/")
        if rel.startswith("..") or rel == "..":
            return None
        return abs_path

    def _read_file(self, args: dict) -> str:
        abs_path = self._resolve(args.get("path"))
        if abs_path is None:
            return "error: path must be a relative path inside the source root"
        if not os.path.isfile(abs_path):
            return f"error: no such file: {args.get('path')}"
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace", newline="") as fh:
                lines = fh.read().split("\n")
        except OSError as err:
            return f"error: cannot read {args.get('path')}: {err}"
        try:
            start = max(int(args.get("start") or 1), 1)
        except (TypeError, ValueError):
            start = 1
        end = min(len(lines), start + MAX_READ_LINES - 1)
        try:
            requested_end = int(args.get("end") or 0)
            if requested_end >= start:
                end = min(end, requested_end)
        except (TypeError, ValueError):
            pass
        rel = os.path.relpath(abs_path, self.source_root).replace("\\", "/")
        out = [f"{rel} (lines {start}-{end} of {len(lines)}):"]
        for i in range(start - 1, end):
            out.append(f"{i + 1}\t{lines[i][:200]}")
        return "\n".join(out)[:MAX_READ_CHARS]

    def _grep(self, args: dict) -> str:
        pattern = args.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            return "error: grep needs a 'pattern' string"
        try:
            re_ = re.compile(pattern)
        except re.error as err:
            return f"error: invalid regex: {err}"
        base = self.source_root
        if args.get("path"):
            abs_path = self._resolve(args.get("path"))
            if abs_path is None:
                return "error: path must be a relative path inside the source root"
            if not os.path.exists(abs_path):
                return f"error: no such path: {args.get('path')}"
            base = abs_path
        files = ([base] if os.path.isfile(base)
                 else [f for f in glob.glob(os.path.join(base, "**", "*"), recursive=True)
                       if os.path.isfile(f)])
        matches = []
        for f in files:
            rel = os.path.relpath(f, self.source_root).replace("\\", "/")
            if _SKIP.search(rel) or not f.endswith(_GREP_EXTS):
                continue
            try:
                with open(f, "r", encoding="utf-8", errors="replace", newline="") as fh:
                    lines = fh.read().split("\n")
            except OSError:
                continue
            for i, ln in enumerate(lines, 1):
                if re_.search(ln):
                    matches.append(f"{rel}:{i}: {ln[:140]}")
                    if len(matches) >= MAX_GREP_MATCHES:
                        return "\n".join(matches) + f"\n… {len(matches)} matches shown, more available"
        if not matches:
            return f"no matches for {pattern!r}"
        return "\n".join(matches)

    def _importers(self, args: dict) -> str:
        if not self.graph:
            return "error: import graph is not available for this run"
        abs_path = self._resolve(args.get("path"))
        if abs_path is None:
            return "error: path must be a relative path inside the source root"
        imp = self.graph["importers"].get(abs_path)
        if not imp:
            return f"no module imports {args.get('path')}"
        rels = sorted(
            os.path.relpath(p, self.source_root).replace("\\", "/") for p in imp
        )[:MAX_IMPORTERS]
        head = f"{len(imp)} module(s) import {args.get('path')}:"
        return head + "\n" + "\n".join(f"- {r}" for r in rels)
