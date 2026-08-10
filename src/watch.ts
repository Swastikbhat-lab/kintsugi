import type { RunConfig, RunState, Finding, LoopEvent } from './types.js';
import { Loop } from './loop.js';

/**
 * Continuous operation.
 *
 * A single run is a snapshot. Running on a cadence is what turns this into
 * maintenance — the interface stays repaired as the app changes underneath it,
 * rather than being repaired once and drifting.
 *
 * The ledger is what makes repetition safe. Without run-to-run memory a
 * scheduled loop rediscovers the same dead end every cycle, re-proposes the
 * same rejected patch, and burns the same effort forever. Because attempts
 * persist per target, each cycle starts knowing what has already failed.
 *
 * Output is deliberately quiet. A cadence that reprints an identical report
 * every cycle trains people to stop reading it, so a cycle that changed
 * nothing says one line.
 */

export interface WatchConfig extends RunConfig {
  /** Minutes between cycles. */
  everyMinutes: number;
  /** Stop after this many cycles. Runs indefinitely when absent. */
  maxCycles?: number;
}

export interface CycleReport {
  cycle: number;
  at: string;
  committed: number;
  /** Findings present now that were absent last cycle. */
  appeared: Finding[];
  /** Findings gone since last cycle, whether repaired here or fixed by hand. */
  resolved: Finding[];
  outstanding: number;
  status: RunState['status'];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function watch(
  config: WatchConfig,
  emit: (e: LoopEvent) => void,
  onCycle?: (r: CycleReport) => void,
): Promise<void> {
  let previous: Map<string, Finding> | null = null;
  let cycle = 0;

  // Signal-driven rather than a fixed count: a scheduled process should stop
  // when asked, and stop cleanly between cycles rather than mid-patch.
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopping) {
    cycle++;

    const loop = new Loop(config, emit);
    const state = await loop.run();

    const current = new Map(state.findings.map((f) => [f.fingerprint, f]));
    const appeared = previous
      ? state.findings.filter((f) => !previous!.has(f.fingerprint))
      : state.findings;
    const resolved = previous
      ? [...previous.values()].filter((f) => !current.has(f.fingerprint))
      : [];

    const report: CycleReport = {
      cycle,
      at: new Date().toISOString(),
      committed: state.attempts.filter((a) => a.outcome === 'committed').length,
      appeared,
      resolved,
      outstanding: state.findings.length,
      status: state.status,
    };

    onCycle?.(report);
    previous = current;

    if (config.maxCycles && cycle >= config.maxCycles) break;
    if (stopping) break;

    // Sleep in short slices so a stop signal is honoured promptly instead of
    // after however long the interval happens to be.
    const until = Date.now() + config.everyMinutes * 60_000;
    while (Date.now() < until && !stopping) {
      await sleep(Math.min(1000, until - Date.now()));
    }
  }
}

/** Terminal rendering for a cycle. Silent when nothing moved. */
export function formatCycle(r: CycleReport): string[] {
  const lines: string[] = [];
  const time = r.at.slice(11, 16);

  if (!r.committed && !r.appeared.length && !r.resolved.length) {
    return [`  ${time}  cycle ${r.cycle}: no change (${r.outstanding} outstanding)`];
  }

  lines.push(`  ${time}  cycle ${r.cycle}`);
  if (r.committed) lines.push(`      ${r.committed} fix(es) applied and verified`);
  for (const f of r.resolved.slice(0, 5)) lines.push(`      resolved  ${f.detector}: ${f.summary}`);
  // New findings are the ones worth waking up for: something regressed, or
  // new code arrived carrying a defect.
  for (const f of r.appeared.slice(0, 5)) lines.push(`      NEW       ${f.detector}: ${f.summary}`);
  if (r.appeared.length > 5) lines.push(`      … and ${r.appeared.length - 5} more new`);
  lines.push(`      ${r.outstanding} outstanding`);
  return lines;
}
