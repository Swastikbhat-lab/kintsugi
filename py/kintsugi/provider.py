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

Two ideas are borrowed from NVIDIA's NOOA (see docs/NOOA.md):

- **Typed I/O with auto-retry.** A reply that breaks the output contract
  (no text block, or text that is not JSON despite a schema) is the model's
  fault, not the harness's — so it is retried with the same prompt instead
  of silently becoming "no proposal". The one provable patch rule — `find`
  must appear verbatim in the file — gets a single corrective re-prompt
  naming the rejected anchors. An empty patch list is a real answer and is
  never re-prompted: retries are for contract violations, not for taste.
- **Model-callable context.** The proposer sees what the harness already
  knows — the ledger's prior attempts at this exact finding and how many
  modules import the target file — so it does not rediscover dead ends or
  guess at blast radius. Context enters *through the prompt* (declared and
  inspectable), never as live objects or code execution.
- **Declared read-only tools.** When context is not enough, the model can
  call three tools the harness executes — read_file, grep, importers (see
  tools.py) — and the results return as bounded text in the next prompt.
  The model can look further; it still cannot touch anything or run code.
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
        # A read-only tool request: the engine executes it and returns the
        # result in the next turn. `patches` stays required (empty while a
        # tool is being called) so a reply is always one of two shapes.
        "tool": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "enum": ["read_file", "grep", "importers"]},
                "args": {"type": "object"},
            },
            "required": ["name", "args"],
        },
    },
    "required": ["patches"],
    "additionalProperties": False,
}

# The proposer's inspection budget: at most this many read-only tool calls
# per finding, so a curious model cannot balloon the prompt.
MAX_TOOL_CALLS = 6

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
end — so a plausible-looking guess costs more than an honest abstention.

You may inspect the codebase before proposing. Three read-only tools are
declared: read_file (read a file, optionally a line range), grep (search
for a regex), importers (which modules import a file). Paths are relative
to the source root. A tool can only look — it cannot modify or execute
anything. To call one, reply {"tool": {"name": ..., "args": {...}},
"patches": []} and the result is returned to you. At most 6 tool calls per
finding; when you are ready to answer, reply {"patches": [...]}."""

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

    def propose(self, finding: dict, source_root: str, context: dict | None = None,
                tools=None):
        # Context and tools are accepted and ignored: the mock replays canned
        # proposals, so there is nothing to contextualize or inspect. The
        # parameters exist so the loop can call every provider with the same
        # signature.
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


class _ContractViolation(RuntimeError):
    """The model replied but broke the output contract — the one retriable
    fault class. API/transport errors are never this: they propagate and the
    loop degrades to rules-only, because a broken credential is not a signal
    to spend more money. (RuntimeError keeps the old callers' exception
    contract: a retried-out model call is still a RuntimeError.)"""


_SHAPE_HINT = (
    "\n\nYour reply must be a single JSON object with exactly one key, "
    '"patches", an array of patch objects {file, find, replace, rationale}. '
    "Return an empty array when you have nothing confident."
)


def _render_tool(tool: dict, result: str) -> str:
    """Render one tool round-trip into the prompt: what was asked and what
    came back, so the model's next reply can build on it. Results are
    bounded text — never live objects, never code to run."""
    name = tool.get("name") or "?"
    args = json.dumps(tool.get("args") or {}, sort_keys=True)
    return (
        f"\n\nTool call: {name}({args})\n"
        f"Result:\n{result}\n"
        '\nReply with your next tool call, or your final {"patches": [...]}.'
    )


def _context_block(context: dict | None, rel: str) -> str:
    """Render the proposer's context into the prompt: what the ledger
    remembers about this finding, and how many modules import its file.

    Context flows in through the prompt — declared, inspectable, and
    bounded — never as live objects or executable code. That is the safe
    half of NOOA's pass-by-reference: the model sees what the harness
    knows without ever being able to touch it.
    """
    if not context:
        return ""
    parts = []
    importers = context.get("importers")
    if importers:
        parts.append(
            f"Note: {rel} is imported by {importers} other module(s). Prefer an "
            "edit confined to this file; a change to a shared file is escalated "
            "and will not be applied automatically."
        )
    history = context.get("ledger")
    if history:
        lines = []
        for a in history[-8:]:
            patch = a.get("patch") or {}
            find = str(patch.get("find") or "")[:60]
            replace = str(patch.get("replace") or "")[:60]
            lines.append(f"- {a.get('outcome')}: {find!r} -> {replace!r}")
        parts.append(
            "The ledger remembers these previous attempts at this exact finding "
            "(outcome: find -> replace):\n"
            + "\n".join(lines)
            + "\nA shape that already failed will be rejected when applied. "
            "Propose something genuinely different, or nothing."
        )
    return "\n\n" + "\n\n".join(parts)


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
        # The usage the most recent top-level call (propose/critique)
        # reported, accumulated across every retry that call made — the
        # tracer's numbers. Real usage straight from the response, never a
        # guess; a retried call costs what its retries cost.
        self.last_usage = None
        self._usage = {"inputTokens": 0, "outputTokens": 0}

    @staticmethod
    def create():
        try:
            from anthropic import Anthropic
            return ClaudeProvider(Anthropic())
        except Exception:
            return None

    def preflight(self):
        self._usage = {"inputTokens": 0, "outputTokens": 0}
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

    def _call(self, system: str, prompt: str, schema: dict, attempts: int = 2):
        """One logical model call. A reply that breaks the output contract is
        retried with the same prompt up to `attempts` times — typed I/O with
        auto-retry, borrowed from NOOA. API errors are never retried here.
        `attempts=1` is the corrective path: the caller already knows the
        prompt changed."""
        last = None
        for _ in range(attempts):
            try:
                return self._call_once(system, prompt, schema)
            except _ContractViolation as err:
                last = err
        raise last

    def _call_once(self, system: str, prompt: str, schema: dict):
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
            acc = self._usage
            acc["inputTokens"] += int(getattr(usage, "input_tokens", 0) or 0)
            acc["outputTokens"] += int(getattr(usage, "output_tokens", 0) or 0)

        if getattr(res, "stop_reason", None) == "refusal":
            return None

        text = None
        for block in getattr(res, "content", []) or []:
            if getattr(block, "type", None) == "text":
                text = getattr(block, "text", None)
                break
        if not text:
            raise _ContractViolation(
                "model returned no text block despite a schema being set")
        try:
            return json.loads(text)
        except Exception as err:
            raise _ContractViolation(
                f"model returned text that was not JSON despite a schema being "
                f"set: {text[:120]}") from err

    @staticmethod
    def _validate(patches, body: str, source_root: str):
        """Turn parsed patches into engine patch dicts. Returns (kept,
        rejected) — `rejected` lists the reasons every proposal was dropped,
        so a failed call knows whether a corrective retry is worth it.

        The only rule enforced here is the one the harness can *prove*: the
        anchor must exist verbatim in the file. Everything else is the
        verify gate's job, not the prompt's."""
        root = os.path.abspath(source_root)
        out = []
        rejected = []
        for p in patches:
            if not isinstance(p, dict):
                rejected.append("<non-object patch>")
                continue
            find = p.get("find")
            if not isinstance(find, str) or find not in body:
                rejected.append(str(find)[:80] if find else "<empty find>")
                continue
            abs_path = os.path.abspath(os.path.join(root, p.get("file", "")))
            rel = os.path.relpath(abs_path, root).replace("\\", "/")
            if not rel or rel.startswith(".."):
                rejected.append(f"file {p.get('file')!r} outside the source root")
                continue
            out.append({
                "id": uuid.uuid4().hex[:8],
                "file": abs_path,
                "find": find,
                "replace": p.get("replace", ""),
                "rationale": f"{p.get('rationale', '')} [proposed by claude]",
                "scope": "local",
            })
        return out, rejected

    def propose(self, finding: dict, source_root: str, context: dict | None = None,
                tools=None):
        file = finding.get("file")
        if not file:
            return []
        self._usage = {"inputTokens": 0, "outputTokens": 0}
        with open(file, encoding="utf-8") as fh:
            body = fh.read()
        rel = os.path.relpath(file, source_root).replace("\\", "/")
        base = "\n".join([
            f"Defect ({finding['check']}, {finding.get('severity')}): {finding['summary']}",
            "",
            "Evidence:",
            json.dumps(finding.get("evidence", {}), indent=2, ensure_ascii=False),
            "",
            f"File: {rel}",
            "```",
            body[:60000] + "\n/* …truncated… */" if len(body) > 60000 else body,
            "```",
        ]) + _context_block(context, rel)

        # The inspection loop: the model may call declared read-only tools
        # (read_file, grep, importers), one per reply, and each result is
        # appended to the prompt as text. The loop is bounded, every result
        # is capped by the runner, and the model can never execute anything
        # — the safe half of NOOA's pass-by-reference, made callable.
        transcript = []
        prompt = base
        tool_calls = 0
        while True:
            parsed = self._call(_SYSTEM, prompt, _PATCH_SCHEMA)
            tool = parsed.get("tool") if isinstance(parsed, dict) else None
            if not tool:
                break
            if tool_calls >= MAX_TOOL_CALLS:
                parsed = None
                break
            result = (
                tools.run(tool.get("name") or "", tool.get("args") or {})
                if tools else "error: no tools available in this run"
            )
            transcript.append(_render_tool(tool, result))
            prompt = base + "".join(transcript)
            tool_calls += 1

        patches = parsed.get("patches") if isinstance(parsed, dict) else None
        patches = parsed.get("patches") if isinstance(parsed, dict) else None
        if not isinstance(patches, list):
            # The server-side schema should make this impossible; a fallback
            # path that skipped it is still not a reason to ship garbage —
            # one corrective retry spelling out the exact contract.
            parsed = self._call(_SYSTEM, prompt + _SHAPE_HINT, _PATCH_SCHEMA, attempts=1)
            patches = parsed.get("patches") if isinstance(parsed, dict) else None
            if not isinstance(patches, list):
                self.last_usage = self._usage or None
                return []

        out, rejected = self._validate(patches, body, source_root)
        if not out and rejected:
            # Every proposal broke the one rule the harness can prove — the
            # anchor must exist verbatim. One corrective retry naming the
            # failures is worth more than a dead-end ledger entry.
            hint = (
                "\n\nYour previous proposal was rejected: every `find` must be "
                "text copied verbatim from the file, appearing in the file. "
                "The rejected anchors: " + "; ".join(rejected[:4])
            )
            parsed = self._call(_SYSTEM, prompt + hint, _PATCH_SCHEMA, attempts=1)
            patches = parsed.get("patches") if isinstance(parsed, dict) else None
            if isinstance(patches, list):
                out, _ = self._validate(patches, body, source_root)

        self.last_usage = self._usage or None
        return out

    def critique(self, patch: dict, finding: dict, question: str):
        self._usage = {"inputTokens": 0, "outputTokens": 0}
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
        self.last_usage = self._usage or None
        if not parsed:
            return None
        return {"verdict": parsed.get("verdict"), "reason": parsed.get("reason")}