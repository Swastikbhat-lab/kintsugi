"""The model seam — the only creative step in the loop.

Observation must not invent a failure, and the verify gate must stay
mechanical — re-running the checks — because a model grading its own patch is
not a gate, it is the same agent wearing two hats. So the model proposes;
the checks decide.

That boundary is also what makes a model safe to add here at all: a bad
proposal costs one reverted patch and one ledger entry, because something
that cannot be argued with checks it afterwards.

This mirrors the TypeScript engine's provider seam (`src/provider.ts`). The
Python engine stays stdlib-only: the Claude provider is an *optional*
dependency (`anthropic`), imported only when present — exactly like the TS
engine's dynamic `@anthropic-ai/sdk` import. With no SDK and no `--llm-mock`,
`create_provider` returns None and the loop runs rules-only.
"""

import json
import os
import uuid

# The three angles a patch is checked from, run in parallel.
CRITIC_QUESTIONS = [
    "Does this edit actually fix the reported defect, rather than something adjacent to it?",
    "Could this edit change behaviour anywhere else — other callers, other modules, other platforms?",
    'Is the "replace this" text unique in that file, and is the result still valid, parseable code?',
]

_PATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "patches": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "Path relative to the source root"},
                    "find": {"type": "string",
                             "description": "Exact existing text to replace, copied verbatim from the file"},
                    "replace": {"type": "string", "description": "Replacement text"},
                    "rationale": {"type": "string",
                                  "description": "Why this clears the finding, in one or two sentences"},
                },
                "required": ["file", "find", "replace", "rationale"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["patches"],
    "additionalProperties": False,
}

_CRITIC_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["keep", "drop"]},
        "reason": {"type": "string"},
    },
    "required": ["verdict", "reason"],
    "additionalProperties": False,
}

_SYSTEM = """You repair defects in a codebase by editing its source.

You are given one check failure and the source file it lives in. Propose the
smallest exact edit that could clear it.

Rules:
- `find` must be text copied verbatim from the file you were shown, long
  enough to appear exactly once. If you cannot find such an anchor, return no
  patches — a patch that does not apply is worse than none.
- Change only what the finding requires. A failing test is fixed by changing
  the code the test measures, not by editing the test to match the code,
  unless the test itself is demonstrably stale (its own message says so).
- Do not reformat, reorder, or "tidy" surrounding code.
- Returning an empty list is a real answer. Some defects need intent no edit
  can carry, and saying so is more useful than guessing.

Your patch will be applied and the checks re-run. If the finding does not
clear, or anything else breaks, the patch is reverted and recorded as a dead
end — so a plausible-looking guess costs more than an honest abstention."""

_CRITIC_SYSTEM = ("You review a single proposed source edit. You did not "
                  "write it and you do not know who did. Judge only what is "
                  "in front of you.")


def create_provider(config: dict):
    """A provider dict-shaped object, or None for a rules-only run.

    Raises ValueError if `llmMock` is set but unreadable — a mock that
    cannot be read is a config error, not an absent model.
    """
    mock = config.get("llmMock")
    if mock:
        return MockProvider(mock)
    return ClaudeProvider.create()


# ------------------------------------------------------------- mock

class MockProvider:
    """Replays canned proposals — the keyless way to exercise the full loop
    (propose -> critics -> gate -> verify -> ledger) in a demo or a test, the
    same way the TypeScript engine's `--llm-mock` exercises its LLM path.

    File shape:

        [ { "match": { "check": "py:test", "contains": "apply_tax" },
            "candidates": [
              { "file": "src/tax.py", "find": "...", "replace": "...",
                "rationale": "..." },
              ...
            ] } ]
    """

    name = "mock"

    def __init__(self, path: str):
        try:
            with open(os.path.abspath(path), encoding="utf-8") as fh:
                self.entries = json.load(fh)
        except Exception as err:
            raise ValueError(f"--llm-mock {path} is not readable: {err}") from err
        # Replayed proposals can declare the token usage a real model would
        # have reported, so keyless runs exercise the same audit/cost path.
        self.last_usage = None

    def _matches(self, finding: dict):
        for entry in self.entries:
            m = entry.get("match", {})
            if m.get("check") and m["check"] != finding["check"]:
                continue
            if m.get("code") and m["code"] != finding.get("code"):
                continue
            if m.get("contains") and m["contains"] not in finding["summary"]:
                continue
            return entry
        return None

    def propose(self, finding: dict, source_root: str):
        entry = self._matches(finding)
        if not entry:
            return []
        root = os.path.abspath(source_root)
        out = []
        for c in entry.get("candidates", []):
            abs_path = os.path.abspath(os.path.join(root, c["file"]))
            rel = os.path.relpath(abs_path, root).replace("\\", "/")
            if not rel or rel.startswith("..") or rel.split("/")[0] in (
                    "node_modules", "dist", "build"):
                continue
            out.append({
                "id": uuid.uuid4().hex[:8],
                "file": abs_path,
                "find": c["find"],
                "replace": c["replace"],
                "rationale": f"{c['rationale']} [proposed by mock]",
                "scope": "local",
            })
        self.last_usage = entry.get("usage") or None
        return out


# ------------------------------------------------------------- claude

class ClaudeProvider:
    """Structured-output calls against the Anthropic API via the optional
    `anthropic` SDK. Returns None from create() when the SDK is missing or
    no credential can be found — whether a credential actually works is
    answered by preflight().
    """

    name = "claude"

    def __init__(self, client):
        self.client = client
        self.degraded = False
        # The usage the most recent model call reported — the tracer's
        # numbers. Real usage straight from the response, never a guess.
        self.last_usage = None

    @staticmethod
    def create():
        try:
            from anthropic import Anthropic
            return ClaudeProvider(Anthropic())
        except Exception:
            return None

    def preflight(self):
        try:
            out = self._call(
                "Reply with the requested JSON and nothing else.",
                'Return {"ok": true}.',
                {
                    "type": "object",
                    "properties": {"ok": {"type": "boolean"}},
                    "required": ["ok"],
                    "additionalProperties": False,
                },
            )
            if out and out.get("ok") is True:
                detail = ("reachable (without server-side fallbacks)" if self.degraded
                          else "reachable")
                return {"ok": True, "detail": detail}
            return {"ok": False, "detail": "call succeeded but returned no usable JSON"}
        except Exception as err:
            return {"ok": False, "detail": str(err)}

    def _call(self, system: str, prompt: str, schema: dict):
        base = {
            "model": "claude-opus-5",
            "max_tokens": 16000,
            "thinking": {"type": "adaptive"},
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        }
        structured = {"effort": "high", "format": {"type": "json_schema", "schema": schema}}

        try:
            res = self.client.beta.messages.create(
                **base,
                output_config=structured,
                **( {} if self.degraded else {
                    "betas": ["server-side-fallback-2026-07-01"],
                    "fallbacks": "default",
                }),
            )
        except Exception as err:
            status = getattr(err, "status_code", None)
            if self.degraded or (status not in (400, 404)):
                raise
            self.degraded = True
            res = self.client.beta.messages.create(**base, output_config=structured)

        usage = getattr(res, "usage", None)
        if usage is not None:
            self.last_usage = {
                "inputTokens": int(getattr(usage, "input_tokens", 0) or 0),
                "outputTokens": int(getattr(usage, "output_tokens", 0) or 0),
            }

        if getattr(res, "stop_reason", None) == "refusal":
            return None

        text = None
        for block in getattr(res, "content", []) or []:
            if getattr(block, "type", None) == "text":
                text = getattr(block, "text", None)
                break
        if not text:
            return None
        try:
            return json.loads(text)
        except Exception as err:
            raise RuntimeError(
                f"model returned text that was not JSON despite a schema being set: "
                f"{text[:120]}") from err

    def propose(self, finding: dict, source_root: str):
        file = finding.get("file")
        if not file:
            return []
        with open(file, encoding="utf-8") as fh:
            body = fh.read()
        rel = os.path.relpath(file, source_root).replace("\\", "/")
        prompt = "\n".join([
            f"Defect ({finding['check']}, {finding.get('severity')}): {finding['summary']}",
            "",
            "Evidence:",
            json.dumps(finding.get("evidence", {}), indent=2, ensure_ascii=False),
            "",
            f"File: {rel}",
            "```",
            body[:60000] + "\n/* …truncated… */" if len(body) > 60000 else body,
            "```",
        ])

        parsed = self._call(_SYSTEM, prompt, _PATCH_SCHEMA)
        if not parsed or not parsed.get("patches"):
            return []

        root = os.path.abspath(source_root)
        out = []
        for p in parsed["patches"]:
            abs_path = os.path.abspath(os.path.join(root, p.get("file", "")))
            rel_path = os.path.relpath(abs_path, root).replace("\\", "/")
            if not rel_path or rel_path.startswith("..") or p.get("find") not in body:
                continue
            out.append({
                "id": uuid.uuid4().hex[:8],
                "file": abs_path,
                "find": p["find"],
                "replace": p["replace"],
                "rationale": f"{p['rationale']} [proposed by claude]",
                "scope": "local",
            })
        return out

    def critique(self, patch: dict, finding: dict, question: str):
        prompt = "\n".join([
            f"Defect: {finding['summary']}",
            "",
            f"Proposed edit to {os.path.relpath(patch['file']).replace(chr(92), '/')}:",
            "--- replace this ---",
            patch["find"],
            "--- with this ---",
            patch["replace"],
            "",
            question,
            "",
            'Answer "drop" only if you can name the concrete problem. Uncertainty alone is '
            '"keep" — a deterministic re-run of the checks happens after you either way.',
        ])
        parsed = self._call(_CRITIC_SYSTEM, prompt, _CRITIC_SCHEMA)
        if not parsed:
            return None
        return {"verdict": parsed.get("verdict"), "reason": parsed.get("reason")}
