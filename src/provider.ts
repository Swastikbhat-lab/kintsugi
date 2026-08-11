import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Finding, Patch } from './types.js';

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
export interface Provider {
  readonly name: string;
  /** Candidate edits for a finding. An empty array is a valid answer. */
  propose(finding: Finding, sourceRoot: string): Promise<Patch[]>;
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

  async propose(finding: Finding, sourceRoot: string): Promise<Patch[]> {
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
  },
  required: ['patches'],
  additionalProperties: false,
} as const;

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
end — so a plausible-looking guess costs more than an honest abstention.`;

export class ClaudeProvider implements Provider {
  readonly name = 'claude';
  private client: any;
  private degraded = false;
  /** The usage the most recent model call reported — the tracer's numbers. */
  lastUsage: { inputTokens: number; outputTokens: number } | null = null;

  private constructor(client: any) {
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

  private async call(system: string, prompt: string, schema: unknown): Promise<any | null> {
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
    this.lastUsage = usage
      ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
      : null;

    if (res.stop_reason === 'refusal') return null;

    const text = res.content.find((b: any) => b.type === 'text')?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `model returned text that was not JSON despite a schema being set: ${text.slice(0, 120)}`,
      );
    }
  }

  async propose(finding: Finding, sourceRoot: string): Promise<Patch[]> {
    const file = finding.file;
    if (!file) return [];

    const { readFile } = await import('node:fs/promises');
    const body = await readFile(file, 'utf8');
    const rel = relative(sourceRoot, file);
    const prompt = [
      `Defect (${finding.check}, ${finding.severity}): ${finding.summary}`,
      ``,
      `Evidence:`,
      JSON.stringify(finding.evidence, null, 2),
      ``,
      `File: ${rel}`,
      '```',
      body.length > 60_000 ? body.slice(0, 60_000) + '\n/* …truncated… */' : body,
      '```',
    ].join('\n');

    const parsed = await this.call(SYSTEM, prompt, PATCH_SCHEMA);
    if (!parsed?.patches) return [];

    return parsed.patches
      .filter((p: any) => {
        const abs = resolve(sourceRoot, p.file);
        const relPath = relative(resolve(sourceRoot), abs);
        return relPath && !relPath.startsWith('..') && body.includes(p.find);
      })
      .map((p: any) => ({
        id: randomUUID().slice(0, 8),
        file: resolve(sourceRoot, p.file),
        find: p.find,
        replace: p.replace,
        rationale: `${p.rationale} [proposed by claude]`,
        scope: 'local' as const,
      }));
  }

  async critique(patch: Patch, finding: Finding, question: string) {
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
    return parsed ? { verdict: parsed.verdict, reason: parsed.reason } : null;
  }
}

/** The three angles a patch is checked from, run in parallel. */
export const CRITIC_QUESTIONS = [
  'Does this edit actually fix the reported defect, rather than something adjacent to it?',
  'Could this edit change behaviour anywhere else — other callers, other modules, other platforms?',
  'Is the "replace this" text unique in that file, and is the result still valid, parseable code?',
];
