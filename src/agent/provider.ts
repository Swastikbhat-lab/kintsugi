import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Finding, Patch } from '../types.js';

/**
 * The model seam.
 *
 * Only one phase of the loop is allowed to be creative. Observation must not
 * hallucinate a measurement, and the verify gate must stay arithmetic — a
 * model grading its own patch is not a gate, it is the same agent wearing two
 * hats. So the model proposes; the browser decides.
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

// ---------------------------------------------------------------- schema

/**
 * The output contract. A response that does not match this shape is rejected
 * by the work graph and retried rather than applied — a patch is an exact
 * edit to someone's source file, so "roughly the right shape" is not a
 * category that may exist here.
 */
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

const SYSTEM = `You repair defects in a running web interface by editing its source.

You are given one measured defect and the source file it lives in. Propose the
smallest exact edit that could clear it.

Rules:
- \`find\` must be text copied verbatim from the file you were shown, long
  enough to appear exactly once. If you cannot find such an anchor, return no
  patches — a patch that does not apply is worse than none.
- Change only what the finding requires. A contrast fix does not restructure a
  component, and a spacing fix does not rename anything.
- Do not reformat, reorder, or "tidy" surrounding code.
- Prefer editing a design token over a single use site when the defect is the
  token's value, since that fixes every other use of it too.
- Returning an empty list is a real answer. Some defects have no safe
  mechanical fix, and saying so is more useful than guessing.

Your patch will be applied and the page re-measured. If the finding does not
clear, or anything else breaks, the patch is reverted and recorded as a dead
end — so a plausible-looking guess costs more than an honest abstention.`;

// ---------------------------------------------------------------- claude

export class ClaudeProvider implements Provider {
  readonly name = 'claude';
  private client: any;

  private constructor(client: any) {
    this.client = client;
  }

  /**
   * Build a client, or return null if the SDK cannot find a credential.
   *
   * Deliberately does not test for `ANTHROPIC_API_KEY` itself. The SDK
   * resolves credentials from several places — that variable, then
   * `ANTHROPIC_AUTH_TOKEN`, then an `ant auth login` profile on disk, then
   * workload identity — so checking one of them reports "no credentials" to
   * someone who is perfectly well authenticated, and the feature looks broken
   * rather than unconfigured. Whether the credential actually works is
   * answered by `preflight()`, which asks the API instead of guessing.
   */
  static async create(): Promise<ClaudeProvider | null> {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      return new ClaudeProvider(new Anthropic());
    } catch {
      // No SDK installed, or no credential the SDK could resolve at all.
      return null;
    }
  }

  /**
   * One cheap call to find out whether this actually works, before the loop
   * starts depending on it.
   *
   * Without this, a rejected request shape or a bad key is indistinguishable
   * from the model simply having no suggestion: both produce zero patches.
   * That is the worst failure mode a proposer can have, because the run looks
   * successful and quietly did half the work.
   */
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

  /** Set once the full request shape has been rejected, so it is tried once. */
  private degraded = false;

  private async call(system: string, prompt: string, schema: unknown): Promise<any | null> {
    const base = {
      model: 'claude-opus-5',
      max_tokens: 16000,
      // Thinking is on by default on this model; stated explicitly so the
      // intent survives a future default change.
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
        // Safety classifiers can decline; the fallback re-serves the request
        // rather than dropping it.
        ...(this.degraded ? {} : {
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        }),
      });
    } catch (err) {
      // Fallbacks combined with structured outputs is not a combination this
      // has been able to verify against the live API. If the shape is
      // rejected, drop the optional half rather than losing the proposer
      // entirely — a refusal that stops is far better than no proposals at
      // all — and remember, so this costs one request and not every request.
      const status = (err as any)?.status;
      if (this.degraded || (status !== 400 && status !== 404)) throw err;
      this.degraded = true;
      res = await this.client.beta.messages.create({ ...base, output_config: structured });
    }

    // Check the stop reason before touching content: on a refusal, content is
    // empty or partial and indexing into it throws.
    if (res.stop_reason === 'refusal') return null;

    const text = res.content.find((b: any) => b.type === 'text')?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // Structured outputs should make this impossible. If it happens, say so
      // plainly rather than surfacing a bare SyntaxError from deep in a loop.
      throw new Error(
        `model returned text that was not JSON despite a schema being set: ${text.slice(0, 120)}`,
      );
    }
  }

  async propose(finding: Finding, sourceRoot: string): Promise<Patch[]> {
    const file = await locateSource(finding, sourceRoot);
    if (!file) return [];

    const body = await readFile(file.absolute, 'utf8');
    // Whole-file context beats a window: the anchor has to be unique in the
    // file, and a window cannot establish that.
    const prompt = [
      `Defect (${finding.detector}, ${finding.severity}): ${finding.summary}`,
      ``,
      `Measured evidence:`,
      JSON.stringify(finding.evidence, null, 2),
      ``,
      `File: ${file.relative}`,
      '```',
      body.length > 60_000 ? body.slice(0, 60_000) + '\n/* …truncated… */' : body,
      '```',
    ].join('\n');

    const parsed = await this.call(SYSTEM, prompt, PATCH_SCHEMA);
    if (!parsed?.patches) return [];

    return parsed.patches
      // A model-supplied path is untrusted input. Anything resolving outside
      // the source root is dropped rather than sanitised into place.
      .filter((p: any) => {
        const abs = resolve(sourceRoot, p.file);
        const rel = relative(resolve(sourceRoot), abs);
        return rel && !rel.startsWith('..') && body.includes(p.find);
      })
      .map((p: any) => ({
        id: randomUUID().slice(0, 8),
        file: resolve(sourceRoot, p.file),
        find: p.find,
        replace: p.replace,
        rationale: `${p.rationale} [proposed by claude]`,
      }));
  }

  async critique(patch: Patch, finding: Finding, question: string) {
    // Deliberately minimal: the finding, the diff, and one question. The
    // proposer's reasoning is withheld — a checker that reads the worker's
    // argument is agreeing with it, not checking it.
    const prompt = [
      `Defect: ${finding.summary}`,
      ``,
      `Proposed edit to ${patch.file}:`,
      `--- replace this ---`,
      patch.find,
      `--- with this ---`,
      patch.replace,
      ``,
      question,
      ``,
      `Answer "drop" only if you can name the concrete problem. Uncertainty alone is "keep" — a deterministic re-measurement runs after you either way.`,
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
  'Does this edit actually address the defect described, rather than something adjacent to it?',
  'Could this edit change behaviour or appearance beyond the defect — other components, other themes, other viewport sizes?',
  'Is the "replace this" text unique in that file, and is the result still valid syntax?',
];

// ---------------------------------------------------------------- helpers

const STYLE_GLOB = '**/*.{css,scss,ts,tsx,js,jsx}';

/**
 * Find the file most likely to own a finding. Deliberately simple: the model
 * gets one file and must anchor inside it, which keeps a bad guess cheap.
 */
async function locateSource(
  finding: Finding,
  sourceRoot: string,
): Promise<{ absolute: string; relative: string } | null> {
  const { glob } = await import('node:fs/promises');
  const ev = finding.evidence as Record<string, unknown>;
  const needles = [
    typeof ev.colour === 'string' ? hexOf(ev.colour) : null,
    typeof ev.selector === 'string' ? ev.selector.split('.')[1] : null,
  ].filter(Boolean) as string[];

  let fallback: { absolute: string; relative: string } | null = null;

  for await (const entry of glob(STYLE_GLOB, { cwd: sourceRoot, withFileTypes: true })) {
    const absolute = `${entry.parentPath}/${entry.name}`;
    const rel = relative(sourceRoot, absolute);
    if (/(^|[\\/])(node_modules|dist|build|\.git|\.botstacks-ui-repair)([\\/]|$)/.test(rel)) continue;

    const text = await readFile(absolute, 'utf8');
    if (needles.some((n) => text.includes(n))) return { absolute, relative: rel };
    if (!fallback && /\.(css|scss)$/.test(rel)) fallback = { absolute, relative: rel };
  }
  return fallback;
}

function hexOf(rgb: string): string | null {
  const m = rgb.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((x) => parseFloat(x.trim()));
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}
