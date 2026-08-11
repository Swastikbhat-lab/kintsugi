import { randomUUID } from 'node:crypto';

/**
 * Optional observability alongside the ledger — harvested from
 * CodeGuardian's Langfuse tracing, rebuilt on the one thing the old version
 * got wrong: *real* numbers. Token usage is captured from the model
 * response, never fabricated from a guess, and cost is derived from it.
 *
 * The tracer is strictly optional and best-effort:
 *   - without LANGFUSE_PUBLIC_KEY/SECRET_KEY it is an inert object;
 *   - with keys but no `langfuse` SDK installed it is an inert object;
 *   - every SDK call is wrapped so a tracing failure can never take the
 *     repair loop down (telemetry must not be load-bearing).
 */
export class Tracer {
  private client: any = null;
  private traceId: string | null = null;

  /** Default list prices (USD per 1M tokens) — override via env for your plan. */
  static inputPrice(): number {
    return Number(process.env.KINTSUGI_INPUT_PRICE ?? 5);
  }
  static outputPrice(): number {
    return Number(process.env.KINTSUGI_OUTPUT_PRICE ?? 25);
  }

  static async create(): Promise<Tracer> {
    const tracer = new Tracer();
    if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return tracer;
    try {
      const { Langfuse } = await import('langfuse');
      tracer.client = new Langfuse({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        host: process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com',
      });
    } catch {
      // SDK not installed — telemetry is optional.
    }
    return tracer;
  }

  get active(): boolean {
    return this.client !== null;
  }

  startRun(config: { sourceRoot: string; checks: string[]; budget: number }): void {
    if (!this.client) return;
    try {
      this.traceId = randomUUID();
      this.client.trace({
        id: this.traceId,
        name: 'kintsugi',
        input: { sourceRoot: config.sourceRoot, checks: config.checks, budget: config.budget },
      });
    } catch {
      this.traceId = null;
    }
  }

  /** A duration-bearing phase of the loop (observe, verify, settle). */
  span(name: string, data: Record<string, unknown>): void {
    if (!this.client || !this.traceId) return;
    try {
      this.client.span({ name, traceId: this.traceId, input: data });
    } catch {
      // Best effort.
    }
  }

  /** A model call, with the usage it actually reported. */
  generation(name: string, usage: { inputTokens?: number; outputTokens?: number } | null | undefined, data: Record<string, unknown>): void {
    if (!this.client || !this.traceId || !usage) return;
    try {
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      this.client.generation({
        name,
        traceId: this.traceId,
        input: data,
        model: 'claude-opus-5',
        usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
        metadata: { costUsd: costUsd(inputTokens, outputTokens) },
      });
    } catch {
      // Best effort.
    }
  }

  flush(): void {
    if (!this.client) return;
    try {
      this.client.flush();
    } catch {
      // Best effort.
    }
  }
}

/** USD cost of a model call from its *reported* token usage. */
export function costUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * Tracer.inputPrice() +
    (outputTokens / 1_000_000) * Tracer.outputPrice()
  );
}
