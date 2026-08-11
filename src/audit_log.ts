/**
 * Local audit trail for the TS engine — the mirror of
 * `py/kintsugi/audit_log.py`. One NDJSON line per ledger attempt
 * (fingerprint, outcome, check/code, patch rationale, provider, and the
 * token usage + derived cost of the model calls made for that finding),
 * plus a final summary line. No Langfuse, no network: `jq -s` the file
 * into a table, or read it with any JSONL tool.
 *
 * Gated by --audit-log <path> on the CLI; without it, this is a no-op.
 */

import { mkdirSync, closeSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface Usage {
  input: number;
  output: number;
}

export class AuditLog {
  private fd: number | null = null;
  private failed = false;

  constructor(
    private path: string | null,
    private costUsd: (input: number, output: number) => number,
  ) {
    if (!path) return;
    try {
      const abs = resolve(path);
      mkdirSync(dirname(abs), { recursive: true });
      this.fd = openSync(abs, 'a');
    } catch (err) {
      this.failed = true;
      console.error(`kintsugi: audit log unavailable (${(err as Error).message})`);
    }
  }

  get active(): boolean {
    return this.fd !== null && !this.failed;
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }

  private write(record: unknown): void {
    if (!this.active) return;
    try {
      writeSync(this.fd!, `${JSON.stringify(record)}\n`);
    } catch {
      // One bad record must not take the run down — drop the stream so the
      // failure is loud once, not on every line.
      this.failed = true;
      this.close();
    }
  }

  attempt(opts: {
    fingerprint: string;
    outcome: string;
    check?: string;
    code?: string;
    rationale?: string;
    provider?: boolean;
    collateral?: string[];
    usage?: Usage;
    runId?: string;
  }): void {
    const usage = opts.usage ?? { input: 0, output: 0 };
    this.write({
      event: 'attempt',
      runId: opts.runId ?? '',
      at: new Date().toISOString(),
      fingerprint: opts.fingerprint,
      outcome: opts.outcome,
      check: opts.check ?? '',
      code: opts.code ?? '',
      patchRationale: opts.rationale ?? '',
      provider: opts.provider ?? false,
      collateral: opts.collateral ?? [],
      usage,
      costUsd: this.costUsd(usage.input, usage.output),
    });
  }

  summary(opts: {
    runId?: string;
    status?: string;
    iterations?: number;
    committed?: number;
    reverted?: number;
    quarantined?: number;
    usage?: Usage;
  }): void {
    const usage = opts.usage ?? { input: 0, output: 0 };
    this.write({
      event: 'summary',
      runId: opts.runId ?? '',
      at: new Date().toISOString(),
      status: opts.status ?? '',
      iterations: opts.iterations ?? 0,
      committed: opts.committed ?? 0,
      reverted: opts.reverted ?? 0,
      quarantined: opts.quarantined ?? 0,
      usage,
      costUsd: this.costUsd(usage.input, usage.output),
    });
  }
}
