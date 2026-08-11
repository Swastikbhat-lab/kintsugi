/**
 * Audit a finished run from its Langfuse trace — the TS mirror of
 * `py/kintsugi/audit.py`.
 *
 * The tracer mirrors the ledger's structure: a final `settle` span carries
 * the full attempt history (fingerprint, outcome, patch, provider,
 * collateral, at), and each model call is a `generation` observation
 * carrying the usage the provider actually reported plus the fingerprint it
 * was made for. This module joins the two and prints a per-finding table:
 *
 *     FINGERPRINT   FINDING                OUTCOME        IN   OUT  COST
 *     3069a1162608  py:test (assert)       committed      0    0    $0.000000
 *
 * Usage: `npm run cli -- --trace <traceId>`
 *
 * Requires LANGFUSE_PUBLIC_KEY/SECRET_KEY and the `@langfuse/client`
 * package. With neither, it prints a clear message and the CLI exits 2 —
 * auditing is optional, never load-bearing.
 */

interface AuditRow {
  fingerprint: string;
  finding: string;
  outcome: string;
  provider: boolean;
  inputTokens: number;
  outputTokens: number;
}

interface AuditResult {
  status: 'ok' | 'no-trace' | 'error';
  rows: AuditRow[];
  total: { input: number; output: number };
  message?: string;
}

function asDict(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Accept a raw record dict, or a model object that can be JSON-serialized. */
function recordFields(record: unknown): Record<string, unknown> {
  if (record && typeof record === 'object') {
    const dict = record as Record<string, unknown>;
    if ('name' in dict || 'type' in dict || 'input' in dict) return dict;
  }
  return {};
}

export async function auditTrace(
  client: { api: { _observations: { getMany(opts: Record<string, unknown>): Promise<any> } } },
  traceId: string,
): Promise<AuditResult> {
  let observations: any;
  try {
    observations = await client.api._observations.getMany({
      traceId,
      type: undefined,
      limit: 1000,
      fields: 'core,basic,usage',
    });
  } catch {
    return { status: 'error', message: 'failed to query Langfuse observations', rows: [], total: { input: 0, output: 0 } };
  }

  const records: unknown[] = Array.isArray(observations?.data) ? observations.data : [];
  if (records.length === 0) {
    return { status: 'no-trace', message: `trace ${traceId} has no observations`, rows: [], total: { input: 0, output: 0 } };
  }

  let settle: Record<string, unknown> | null = null;
  const generations: Record<string, unknown>[] = [];
  for (const raw of records) {
    const rec = recordFields(raw);
    const name = String(rec.name ?? '');
    const type = String(rec.type ?? '').toUpperCase();
    if (name === 'settle') settle = rec;
    else if (type === 'GENERATION' || name === 'propose') generations.push(rec);
  }

  const attempts: Record<string, unknown>[] = [];
  if (settle) {
    const input = asDict(settle.input);
    const list = input.attempts;
    if (Array.isArray(list)) attempts.push(...(list as Record<string, unknown>[]));
  }

  // Join: fingerprint → { input, output }. Multiple model calls for one
  // finding accumulate into that finding's row.
  const usageByFp = new Map<string, { input: number; output: number }>();
  for (const g of generations) {
    const input = asDict(g.input);
    const fp = typeof input.fingerprint === 'string' ? input.fingerprint : '';
    if (!fp) continue;
    const usage = asDict(g.usage);
    const entry = usageByFp.get(fp) ?? { input: 0, output: 0 };
    entry.input += Number(usage.input ?? 0) || 0;
    entry.output += Number(usage.output ?? 0) || 0;
    usageByFp.set(fp, entry);
  }

  const rows: AuditRow[] = attempts.map((a) => {
    const fp = String(a.fingerprint ?? '');
    const tokens = usageByFp.get(fp) ?? { input: 0, output: 0 };
    const patch = asDict(a.patch);
    const finding = `${String(a.check ?? '')} (${String(patch.rationale ?? '')})`.trim() || String(a.check ?? '');
    return {
      fingerprint: fp,
      finding: finding.slice(0, 64),
      outcome: String(a.outcome ?? ''),
      provider: Boolean(a.provider),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
    };
  });

  rows.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  const total = rows.reduce(
    (acc, r) => ({ input: acc.input + r.inputTokens, output: acc.output + r.outputTokens }),
    { input: 0, output: 0 },
  );
  return { status: 'ok', rows, total };
}

/** Render the audit result as a table. costUsd is injected for consistency. */
export function printAudit(result: AuditResult, costUsd: (i: number, o: number) => number): string {
  if (result.status === 'no-trace' || result.status === 'error') return result.message ?? result.status;
  if (result.rows.length === 0) return 'Trace has no kintsugi attempt history (no repairs attempted).';
  const lines = [
    'FINGERPRINT    FINDING                                          OUTCOME        IN    OUT       COST',
    '-'.repeat(96),
  ];
  for (const r of result.rows) {
    const cost = costUsd(r.inputTokens, r.outputTokens);
    lines.push(
      `${r.fingerprint.padEnd(14)} ${r.finding.padEnd(46)} ${r.outcome.padEnd(12)} ` +
      `${String(r.inputTokens).padStart(6)} ${String(r.outputTokens).padStart(6)} ${cost.toFixed(6).padStart(10)}`,
    );
  }
  lines.push('-'.repeat(96));
  lines.push(
    `TOTAL${' '.repeat(12)} ${''.padEnd(46)} ${''.padEnd(12)} ` +
    `${String(result.total.input).padStart(6)} ${String(result.total.output).padStart(6)} ` +
    `${costUsd(result.total.input, result.total.output).toFixed(6).padStart(10)}`,
  );
  return lines.join('\n');
}

/** A read-only Langfuse client from env keys — or null when SDK/keys absent. */
export async function createAuditClient(): Promise<{ api: { _observations: any } } | null> {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return null;
  try {
    const { LangfuseClient } = await import('@langfuse/client');
    return new LangfuseClient() as any;
  } catch {
    return null;
  }
}
