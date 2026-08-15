import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Finding, Patch } from './types.js';
import type { ToolRunner } from './tools.js';

/**
 * The model seam.
 *
 * Only one phase of the loop is allowed to be creative. Observation must not
 * invent a failure, and the verify gate must stay mechanical — re-running the
 * checks — because a model grading its own patch is not a gate, it is the
 * same agent wearing two hats. So the model proposes; the checks decide.
 *
 * That boundary is also what makes a model safe to add here at all: a bad
 * proposal costs one reverted patch and one ledger entry, because something
 * that cannot be argued with checks it afterwards.
 */
/**
 * What the harness already knows about a finding, handed to the model
 * through the prompt: the ledger's prior attempts at this exact fingerprint
 * and how many modules import its file. Rendered text, never live objects —
 * the safe half of NOOA's pass-by-reference (see docs/NOOA.md).
 */
export interface ProposerContext {
  ledger?: { outcome: string; patch: { find?: string; replace?: string } }[];
  importers?: number;
}

/**
 * The tester's output: one new test file that fails on the current tree
 * and reproduces the finding — the red half of red-green. Written before
 * any repair is proposed, so the repair's only job is to turn it green.
 */
export interface ReproTest {
  /** Path relative to the source root where the test goes. */
  file: string;
  /** Full content of the test file. */
  content: string;
}

export interface Provider {
  readonly name: string;
  /**
   * Candidate edits for a finding. An empty array is a valid answer.
   * `tools` lets the model inspect the repo through declared read-only
   * tools (read_file / grep / importers) before proposing; it can never
   * execute anything.
   */
  propose(
    finding: Finding,
    sourceRoot: string,
    context?: ProposerContext,
    tools?: ToolRunner,
  ): Promise<Patch[]>;
  /**
   * The researcher + planner step: localize the finding to the symbol and
   * call chain that actually cause it, and name the repair strategy —
   * *before* any patch is proposed. Empirically (SWE-bench agent studies)
   * symbol-level localization is the strongest predictor of a successful
   * repair. Providers that cannot localize return `null` and the loop
   * proposes from the raw finding, as before.
   */
  localize?(
    finding: Finding,
    sourceRoot: string,
    context?: ProposerContext,
    tools?: ToolRunner,
  ): Promise<{
    rootCause: string;
    symbols: string[];
    strategy: string;
    confidence: 'high' | 'medium' | 'low';
  } | null>;
  /**
   * The tester step: write a failing repro test for the finding *before*
   * any repair is proposed. Empirically (SWE-bench agent studies) a
   * correct reproduction is what separates a fix from a guess — the repro
   * is red on the broken tree, the repair must turn it green, and the
   * verify gate proves both halves. Providers that cannot write a repro
   * return `null` and the loop proposes as before.
   */
  reproduce?(
    finding: Finding,
    sourceRoot: string,
    context?: ProposerContext,
    tools?: ToolRunner,
  ): Promise<ReproTest | null>;
  /**
   * Judge a patch on one axis, with no knowledge of who wrote it or why.
   * Providers that cannot judge return `null` and are simply not consulted.
   */
  critique?(
    patch: Patch,
    finding: Finding,
    question: string,
  ): Promise<{ verdict: 'keep' | 'drop'; reason: string } | null>;
}

export function createProvider(config: { llmMock?: string }): Promise<Provider | null> {
  if (config.llmMock) {
    try {
      return Promise.resolve(new MockProvider(config.llmMock));
    } catch (err) {
      return Promise.reject(new Error(`--llm-mock ${config.llmMock} is not readable: ${(err as Error).message}`));
    }
  }
  return ClaudeProvider.create();
}

// ---------------------------------------------------------------- mock

interface MockEntry {
  match: { check?: string; code?: string; contains?: string };
  candidates: { file: string; find: string; replace: string; rationale: string }[];
  /** Optional researcher + planner replay for this finding class. When
   * present, keyless runs exercise the localize step too — the mock's
   * localizations are canned the same way its proposals are. */
  localize?: {
    rootCause: string;
    symbols: string[];
    strategy: string;
    confidence: 'high' | 'medium' | 'low';
  };
  /** Optional tester replay: a canned failing repro test for this finding
   * class, written before any repair — red-green exercised keylessly. */
  repro?: { file: string; content: string };
}

/**
 * Replays canned proposals — the keyless way to exercise the full loop
 * (propose → checkers → gate → verify → ledger) in a demo or a test, the
 * same way scrape-heal's `--llm-mock` exercises its LLM path.
 */
export class MockProvider implements Provider {
  readonly name = 'mock';
  private entries: MockEntry[];
  /** Replayed proposals can declare usage — keyless runs exercise the same
   * audit/cost path a real model call would. */
  lastUsage: { inputTokens?: number; outputTokens?: number } | null = null;

  constructor(path: string) {
    this.entries = JSON.parse(readFileSync(resolve(path), 'utf8'));
  }

  private matches(finding: Finding): MockEntry | undefined {
    return this.entries.find((e) => {
      const m = e.match;
      if (m.check && m.check !== finding.check) return false;
      if (m.code && m.code !== finding.code) return false;
      if (m.contains && !finding.summary.includes(m.contains)) return false;
      return true;
    });
  }

  /**
   * The mock localizes only what its entries declare: an entry may carry a
   * canned `localize` block, replayed for the same finding class as its
   * proposals. Entries without one return null — the loop proposes from
   * the raw finding, exactly as before — so keyless runs stay
   * deterministic while still being able to exercise the researcher +
   * planner step end to end.
   */
  async localize(finding: Finding): Promise<{
    rootCause: string;
    symbols: string[];
    strategy: string;
    confidence: 'high' | 'medium' | 'low';
  } | null> {
    return this.matches(finding)?.localize ?? null;
  }

  /** The tester replays only what its entries declare, like localize. */
  async reproduce(finding: Finding): Promise<ReproTest | null> {
    return this.matches(finding)?.repro ?? null;
  }

  async propose(
    finding: Finding,
    sourceRoot: string,
    _context?: ProposerContext,
    _tools?: ToolRunner,
  ): Promise<Patch[]> {
    // Context and tools are accepted and ignored: the mock replays canned
    // proposals, so there is nothing to contextualize or inspect. The
    // parameters exist so the loop can call every provider the same way.
    const entry = this.matches(finding);
    if (!entry) return [];

    const root = resolve(sourceRoot);
    this.lastUsage = (entry as any).usage ?? null;
    return entry.candidates
      .filter((c) => {
        const abs = resolve(root, c.file);
        const rel = relative(root, abs);
        return rel && !rel.startsWith('..') && !/^(node_modules|dist|build)/.test(rel);
      })
      .map((c) => ({
        id: randomUUID().slice(0, 8),
        file: resolve(root, c.file),
        find: c.find,
        replace: c.replace,
        rationale: `${c.rationale} [proposed by mock]`,
        scope: 'local' as const,
      }));
  }
}

// ---------------------------------------------------------------- claude

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    patches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path relative to the source root' },
          find: { type: 'string', description: 'Exact existing text to replace, copied verbatim from the file' },
          replace: { type: 'string', description: 'Replacement text' },
          rationale: { type: 'string', description: 'Why this clears the finding, in one or two sentences' },
        },
        required: ['file', 'find', 'replace', 'rationale'],
        additionalProperties: false,
      },
    },
    // A read-only tool request: the engine executes it and returns the
    // result in the next turn. `patches` stays required (empty while a tool
    // is being called) so a reply is always one of two shapes.
    tool: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['read_file', 'grep', 'importers'] },
        args: { type: 'object' },
      },
      required: ['name', 'args'],
    },
  },
  required: ['patches'],
  additionalProperties: false,
} as const;

/** The researcher's inspection budget: at most this many read-only tool
 * calls while localizing a finding, so a curious model cannot balloon the
 * prompt. The proposer then gets its own budget on top. */
const MAX_LOCALIZE_TOOL_CALLS = 4;

/** The proposer's inspection budget: at most this many read-only tool calls
 * per finding, so a curious model cannot balloon the prompt. */
const MAX_TOOL_CALLS = 6;

const LOCALIZE_SCHEMA = {
  type: 'object',
  properties: {
    rootCause: { type: 'string', description: 'One sentence: the actual defect, distinct from the reported symptom' },
    symbols: {
      type: 'array',
      items: { type: 'string' },
      description: 'The symbol(s) where the defect lives, not where it was reported',
    },
    strategy: { type: 'string', description: 'One sentence: the smallest repair that could clear the finding' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    // A read-only tool request, like the proposer's: the engine executes it
    // and returns the result in the next turn.
    tool: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['read_file', 'grep', 'importers'] },
        args: { type: 'object' },
      },
      required: ['name', 'args'],
    },
  },
  required: ['rootCause', 'symbols', 'strategy', 'confidence'],
  additionalProperties: false,
} as const;

const LOCALIZE_SYSTEM = `You localize a code defect before it is repaired.

You are given one check failure and the source file it lives in. Your job
is to find the symbol and call chain that actually CAUSE the failure —
which is often not the file or line that reported it.

Empirically, code-symbol-level localization predicts repair success far
better than file-level. A file is where the symptom appears; a symbol is
where the defect lives.

Rules:
- Follow the trace: read the failing assertion / import / call and walk to
  the root. Quote the line that proves it.
- Distinguish root cause from symptom. The failing test is the symptom;
  the wrong constant, missing export, or stale import is the cause.
- If you cannot name a symbol with confidence, set confidence to low and
  say so. A vague localization is worse than none.
- You only localize. You do not propose patches.

You may inspect the codebase first with read_file, grep, and importers.
To call one, reply {"tool": {"name": ..., "args": {...}}} and the result
is returned to you. At most 4 tool calls; when ready, reply with the
localization object.`;

const REPRO_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Path of the new test file, relative to the source root' },
    content: { type: 'string', description: 'Full content of the test file' },
    // A read-only tool request, like the others: the engine executes it
    // and returns the result in the next turn.
    tool: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['read_file', 'grep', 'importers'] },
        args: { type: 'object' },
      },
      required: ['name', 'args'],
    },
  },
  required: ['file', 'content'],
  additionalProperties: false,
} as const;

/** The tester's inspection budget, like the researcher's. */
const MAX_REPRO_TOOL_CALLS = 4;

const REPRO_SYSTEM = `You write a failing test that reproduces a code defect.

You are given one check failure and the source file it lives in. Write one
minimal test that FAILS on the current tree and would PASS once the defect
is fixed. This is the red half of red-green: it runs before any repair, and
the repair is only accepted if this test turns green.

Rules:
- Use the repo's own test runner and conventions. Follow an existing test
  file in the repo for the import style, framework, and assertion API.
- The test must target the DEFECT, not the symptom: it asserts the correct
  behaviour directly.
- One test, one assertion. No mocking, no setup beyond what the assertion
  needs, no coverage of adjacent behaviour.
- If you cannot write a meaningful repro (the defect is not test-observable),
  reply with empty strings for both file and content — an abstention is
  better than a test that cannot fail.

You may inspect the codebase first with read_file, grep, and importers.
To call one, reply {"tool": {"name": ..., "args": {...}}} and the result
is returned to you. At most 4 tool calls; when ready, reply with the
repro test.`;

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['keep', 'drop'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
} as const;

const SYSTEM = `You repair defects in a codebase by editing its source.

You are given one check failure and the source file it lives in. Propose the
smallest exact edit that could clear it.

Rules:
- \`find\` must be text copied verbatim from the file you were shown, long
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
finding; when you are ready to answer, reply {"patches": [...]}.`;

/** The model replied but broke the output contract — the one retriable fault
 * class. API/transport errors are never this: they propagate and the loop
 * degrades to rules-only, because a broken credential is not a signal to
 * spend more money. */
class ContractViolation extends Error {}

const SHAPE_HINT =
  '\n\nYour reply must be a single JSON object with exactly one key, "patches", ' +
  'an array of patch objects {file, find, replace, rationale}. Return an ' +
  'empty array when you have nothing confident.';

/** Render one tool round-trip into the prompt: what was asked and what came
 * back, so the model's next reply can build on it. Results are bounded
 * text — never live objects, never code to run. */
function renderTool(tool: { name?: string; args?: Record<string, unknown> }, result: string): string {
  const name = tool.name ?? '?';
  const args = JSON.stringify(tool.args ?? {}, Object.keys(tool.args ?? {}).sort());
  return (
    `\n\nTool call: ${name}(${args})\n` +
    `Result:\n${result}\n` +
    '\nReply with your next tool call, or your final {"patches": [...]}.'
  );
}

/** Render a localization into the proposer's prompt: the researcher's
 * root-cause map, the symbols it names, and the repair strategy it chose.
 * The proposer codes against this instead of the raw symptom. */
function localizationBlock(loc: {
  rootCause: string;
  symbols: string[];
  strategy: string;
  confidence: string;
} | null): string {
  if (!loc) return '';
  const parts = [
    'The researcher localized this finding before you (confidence: ' +
      `${loc.confidence}). Code against the root cause, not the symptom:`,
    `- Root cause: ${loc.rootCause}`,
    `- Defect symbol(s): ${loc.symbols.join(', ') || '(unknown)'}`,
    `- Repair strategy: ${loc.strategy}`,
  ];
  return '\n\n' + parts.join('\n');
}

/** Render the proposer's context into the prompt: what the ledger remembers
 * about this finding, and how many modules import its file. Context flows in
 * through the prompt — declared, inspectable, bounded — never as live
 * objects or executable code. */
function contextBlock(context: ProposerContext | undefined, rel: string): string {
  if (!context) return '';
  const parts: string[] = [];
  if (context.importers) {
    parts.push(
      `Note: ${rel} is imported by ${context.importers} other module(s). Prefer an ` +
        'edit confined to this file; a change to a shared file is escalated ' +
        'and will not be applied automatically.',
    );
  }
  if (context.ledger && context.ledger.length) {
    const lines = context.ledger.slice(-8).map((a) => {
      const find = (a.patch.find ?? '').slice(0, 60);
      const replace = (a.patch.replace ?? '').slice(0, 60);
      return `- ${a.outcome}: ${JSON.stringify(find)} -> ${JSON.stringify(replace)}`;
    });
    parts.push(
      'The ledger remembers these previous attempts at this exact finding ' +
        '(outcome: find -> replace):\n' +
        lines.join('\n') +
        '\nA shape that already failed will be rejected when applied. ' +
        'Propose something genuinely different, or nothing.',
    );
  }
  return '\n\n' + parts.join('\n\n');
}

export class ClaudeProvider implements Provider {
  readonly name = 'claude';
  private client: any;
  private degraded = false;
  /**
   * The usage the most recent top-level call (propose/critique) reported,
   * accumulated across every retry that call made — the tracer's numbers.
   * Real usage straight from the response, never a guess; a retried call
   * costs what its retries cost.
   */
  lastUsage: { inputTokens: number; outputTokens: number } | null = null;
  private usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };

  constructor(client: any) {
    this.client = client;
  }

  /**
   * Build a client, or return null if the SDK cannot find a credential.
   * Deliberately does not test for ANTHROPIC_API_KEY itself: the SDK
   * resolves credentials from several places, so checking one of them
   * reports "no credentials" to someone who is perfectly well
   * authenticated. Whether the credential works is answered by preflight().
   */
  static async create(): Promise<ClaudeProvider | null> {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      return new ClaudeProvider(new Anthropic());
    } catch {
      return null;
    }
  }

  async preflight(): Promise<{ ok: boolean; detail: string }> {
    this.usage = { inputTokens: 0, outputTokens: 0 };
    try {
      const out = await this.call(
        'Reply with the requested JSON and nothing else.',
        'Return {"ok": true}.',
        {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      );
      if (out?.ok === true) {
        return { ok: true, detail: this.degraded ? 'reachable (without server-side fallbacks)' : 'reachable' };
      }
      return { ok: false, detail: 'call succeeded but returned no usable JSON' };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /**
   * One logical model call. A reply that breaks the output contract is
   * retried with the same prompt up to `attempts` times — typed I/O with
   * auto-retry, borrowed from NOOA. API errors are never retried here.
   * `attempts = 1` is the corrective path: the caller already knows the
   * prompt changed.
   */
  private async call(
    system: string,
    prompt: string,
    schema: unknown,
    attempts = 2,
  ): Promise<any | null> {
    let last: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.callOnce(system, prompt, schema);
      } catch (err) {
        if (!(err instanceof ContractViolation)) throw err;
        last = err;
      }
    }
    throw last;
  }

  private async callOnce(system: string, prompt: string, schema: unknown): Promise<any | null> {
    const base = {
      model: 'claude-opus-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' as const },
      system,
      messages: [{ role: 'user' as const, content: prompt }],
    };
    const structured = { effort: 'high' as const, format: { type: 'json_schema' as const, schema } };

    let res;
    try {
      res = await this.client.beta.messages.create({
        ...base,
        output_config: structured,
        ...(this.degraded ? {} : {
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        }),
      });
    } catch (err) {
      const status = (err as any)?.status;
      if (this.degraded || (status !== 400 && status !== 404)) throw err;
      this.degraded = true;
      res = await this.client.beta.messages.create({ ...base, output_config: structured });
    }

    // Real usage, straight from the response — observability is only worth
    // anything when the numbers are the model's, not a guess.
    const usage = res.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usage) {
      this.usage.inputTokens += usage.input_tokens ?? 0;
      this.usage.outputTokens += usage.output_tokens ?? 0;
    }

    if (res.stop_reason === 'refusal') return null;

    const text = res.content.find((b: any) => b.type === 'text')?.text;
    if (!text) {
      throw new ContractViolation('model returned no text block despite a schema being set');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ContractViolation(
        `model returned text that was not JSON despite a schema being set: ${text.slice(0, 120)}`,
      );
    }
  }

  async propose(
    finding: Finding,
    sourceRoot: string,
    context?: ProposerContext & { localization?: {
      rootCause: string;
      symbols: string[];
      strategy: string;
      confidence: string;
    } },
    tools?: ToolRunner,
  ): Promise<Patch[]> {
    const file = finding.file;
    if (!file) return [];
    this.usage = { inputTokens: 0, outputTokens: 0 };

    const { readFile } = await import('node:fs/promises');
    const body = await readFile(file, 'utf8');
    const rel = relative(sourceRoot, file);
    const base =
      [
        `Defect (${finding.check}, ${finding.severity}): ${finding.summary}`,
        ``,
        `Evidence:`,
        JSON.stringify(finding.evidence, null, 2),
        ``,
        `File: ${rel}`,
        '```',
        body.length > 60_000 ? body.slice(0, 60_000) + '\n/* …truncated… */' : body,
        '```',
      ].join('\n') + localizationBlock(context?.localization ?? null) + contextBlock(context, rel);

    // The inspection loop: the model may call declared read-only tools
    // (read_file, grep, importers), one per reply, and each result is
    // appended to the prompt as text. The loop is bounded, every result is
    // capped by the runner, and the model can never execute anything — the
    // safe half of NOOA's pass-by-reference, made callable.
    const transcript: string[] = [];
    let prompt = base;
    let toolCalls = 0;
    let parsed: any = null;
    for (;;) {
      parsed = await this.call(SYSTEM, prompt, PATCH_SCHEMA);
      const tool = parsed && typeof parsed === 'object' ? (parsed as any).tool : undefined;
      if (!tool) break;
      if (toolCalls >= MAX_TOOL_CALLS) {
        parsed = null;
        break;
      }
      const result = tools
        ? tools.run(tool.name ?? '', tool.args ?? {})
        : 'error: no tools available in this run';
      transcript.push(renderTool(tool, result));
      prompt = base + transcript.join('');
      toolCalls++;
    }

    let patches = parsed && typeof parsed === 'object' ? (parsed as any).patches : undefined;
    if (!Array.isArray(patches)) {
      // The server-side schema should make this impossible; a fallback path
      // that skipped it is still not a reason to ship garbage — one
      // corrective retry spelling out the exact contract.
      parsed = await this.call(SYSTEM, prompt + SHAPE_HINT, PATCH_SCHEMA, 1);
      patches = parsed && typeof parsed === 'object' ? (parsed as any).patches : undefined;
      if (!Array.isArray(patches)) {
        this.lastUsage = this.usage;
        return [];
      }
    }

    let { kept, rejected } = ClaudeProvider.validatePatches(patches, body, sourceRoot);
    if (kept.length === 0 && rejected.length > 0) {
      // Every proposal broke the one rule the harness can prove — the
      // anchor must exist verbatim. One corrective retry naming the
      // failures is worth more than a dead-end ledger entry.
      const hint =
        '\n\nYour previous proposal was rejected: every `find` must be text ' +
        'copied verbatim from the file, appearing in the file. The rejected ' +
        `anchors: ${rejected.slice(0, 4).join('; ')}`;
      parsed = await this.call(SYSTEM, prompt + hint, PATCH_SCHEMA, 1);
      patches = parsed && typeof parsed === 'object' ? (parsed as any).patches : undefined;
      if (Array.isArray(patches)) {
        kept = ClaudeProvider.validatePatches(patches, body, sourceRoot).kept;
      }
    }

    this.lastUsage = this.usage;
    return kept;
  }

  /**
   * Turn parsed patches into engine patches. Returns `kept` and `rejected`
   * — `rejected` lists why every proposal was dropped, so a failed call
   * knows whether a corrective retry is worth it. The only rule enforced
   * here is the one the harness can *prove*: the anchor must exist verbatim
   * in the file. Everything else is the verify gate's job, not the prompt's.
   */
  private static validatePatches(
    patches: any[],
    body: string,
    sourceRoot: string,
  ): { kept: Patch[]; rejected: string[] } {
    const root = resolve(sourceRoot);
    const kept: Patch[] = [];
    const rejected: string[] = [];
    for (const p of patches) {
      if (!p || typeof p !== 'object') {
        rejected.push('<non-object patch>');
        continue;
      }
      const find = p.find;
      if (typeof find !== 'string' || !body.includes(find)) {
        rejected.push(find ? find.slice(0, 80) : '<empty find>');
        continue;
      }
      const abs = resolve(root, p.file ?? '');
      const relPath = relative(root, abs);
      if (!relPath || relPath.startsWith('..')) {
        rejected.push(`file ${JSON.stringify(p.file)} outside the source root`);
        continue;
      }
      kept.push({
        id: randomUUID().slice(0, 8),
        file: abs,
        find,
        replace: p.replace ?? '',
        rationale: `${p.rationale ?? ''} [proposed by claude]`,
        scope: 'local' as const,
      });
    }
    return { kept, rejected };
  }

  /**
   * The researcher + planner step. Called before propose when the rules
   * cannot reach the finding. Its result is rendered into the proposer's
   * prompt, so the proposer codes against a localization instead of a
   * symptom. A localization that names the wrong symbol is caught by the
   * same verify gate that catches a wrong patch — the loop's trust does
   * not move to this step, only its starting point.
   */
  async localize(
    finding: Finding,
    sourceRoot: string,
    _context?: ProposerContext,
    tools?: ToolRunner,
  ): Promise<{
    rootCause: string;
    symbols: string[];
    strategy: string;
    confidence: 'high' | 'medium' | 'low';
  } | null> {
    const file = finding.file;
    if (!file) return null;
    this.usage = { inputTokens: 0, outputTokens: 0 };

    const { readFile } = await import('node:fs/promises');
    let body = '';
    try {
      body = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    const rel = relative(sourceRoot, file);
    const base =
      [
        `Defect (${finding.check}, ${finding.severity}): ${finding.summary}`,
        '',
        `Evidence:`,
        JSON.stringify(finding.evidence, null, 2),
        '',
        `Reported in: ${rel}`,
        '```',
        body.length > 60_000 ? body.slice(0, 60_000) + '\n/* …truncated… */' : body,
        '```',
      ].join('\n');

    const transcript: string[] = [];
    let prompt = base;
    let toolCalls = 0;
    let parsed: any = null;
    for (;;) {
      parsed = await this.call(LOCALIZE_SYSTEM, prompt, LOCALIZE_SCHEMA);
      const tool = parsed && typeof parsed === 'object' ? (parsed as any).tool : undefined;
      if (!tool) break;
      if (toolCalls >= MAX_LOCALIZE_TOOL_CALLS) {
        parsed = null;
        break;
      }
      const result = tools
        ? tools.run(tool.name ?? '', tool.args ?? {})
        : 'error: no tools available in this run';
      transcript.push(renderTool(tool, result));
      prompt = base + transcript.join('');
      toolCalls++;
    }

    this.lastUsage = this.usage;
    if (!parsed || typeof parsed !== 'object') return null;
    const confidence = parsed.confidence;
    if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') return null;
    return {
      rootCause: String(parsed.rootCause ?? ''),
      symbols: Array.isArray(parsed.symbols) ? parsed.symbols.map(String) : [],
      strategy: String(parsed.strategy ?? ''),
      confidence,
    };
  }

  /**
   * The tester step. Called before propose, so the repair's only job is
   * to turn the repro green. The loop validates that the file is inside
   * the source root and does not already exist, then confirms it is red
   * by running the checks — a repro that cannot fail is discarded the
   * same way a patch that cannot apply is.
   */
  async reproduce(
    finding: Finding,
    sourceRoot: string,
    _context?: ProposerContext,
    tools?: ToolRunner,
  ): Promise<ReproTest | null> {
    const file = finding.file;
    if (!file) return null;
    this.usage = { inputTokens: 0, outputTokens: 0 };

    const { readFile } = await import('node:fs/promises');
    let body = '';
    try {
      body = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    const rel = relative(sourceRoot, file);
    const base =
      [
        `Defect (${finding.check}, ${finding.severity}): ${finding.summary}`,
        '',
        `Evidence:`,
        JSON.stringify(finding.evidence, null, 2),
        '',
        `Reported in: ${rel}`,
        '```',
        body.length > 60_000 ? body.slice(0, 60_000) + '\n/* …truncated… */' : body,
        '```',
      ].join('\n');

    const transcript: string[] = [];
    let prompt = base;
    let toolCalls = 0;
    let parsed: any = null;
    for (;;) {
      parsed = await this.call(REPRO_SYSTEM, prompt, REPRO_SCHEMA);
      const tool = parsed && typeof parsed === 'object' ? (parsed as any).tool : undefined;
      if (!tool) break;
      if (toolCalls >= MAX_REPRO_TOOL_CALLS) {
        parsed = null;
        break;
      }
      const result = tools
        ? tools.run(tool.name ?? '', tool.args ?? {})
        : 'error: no tools available in this run';
      transcript.push(renderTool(tool, result));
      prompt = base + transcript.join('');
      toolCalls++;
    }

    this.lastUsage = this.usage;
    if (!parsed || typeof parsed !== 'object') return null;
    const reproFile = String(parsed.file ?? '');
    const content = String(parsed.content ?? '');
    // Abstention is a real answer: a repro that cannot fail would be
    // discarded by the loop's red check anyway, so declare it as none.
    if (!reproFile || !content) return null;
    return { file: reproFile, content };
  }

  async critique(patch: Patch, finding: Finding, question: string) {
    this.usage = { inputTokens: 0, outputTokens: 0 };
    const prompt = [
      `Defect: ${finding.summary}`,
      ``,
      `Proposed edit to ${relative(process.cwd(), patch.file)}:`,
      `--- replace this ---`,
      patch.find,
      `--- with this ---`,
      patch.replace,
      ``,
      question,
      ``,
      `Answer "drop" only if you can name the concrete problem. Uncertainty alone is "keep" — a deterministic re-run of the checks happens after you either way.`,
    ].join('\n');

    const parsed = await this.call(
      'You review a single proposed source edit. You did not write it and you do not know who did. Judge only what is in front of you.',
      prompt,
      CRITIC_SCHEMA,
    );
    this.lastUsage = this.usage;
    return parsed ? { verdict: parsed.verdict, reason: parsed.reason } : null;
  }
}

/** The three angles a patch is checked from, run in parallel. */
export const CRITIC_QUESTIONS = [
  'Does this edit actually fix the reported defect, rather than something adjacent to it?',
  'Could this edit change behaviour anywhere else — other callers, other modules, other platforms?',
  'Is the "replace this" text unique in that file, and is the result still valid, parseable code?',
];
