import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * Watch mode: keep a repo repaired as it drifts, not just on demand.
 *
 * The session sits between a change signal (fs.watch events, or a poller)
 * and the repair loop. It debounces bursts into a single run, runs passes
 * strictly serially, and — the part that makes continuous repair safe — a
 * run's own writes are dropped from the mid-run change set, so the loop
 * never re-triggers itself. A human's edit that lands mid-run does.
 */

/** Paths that never count as drift: build output, caches, VCS, venvs. */
const WATCH_SKIP =
  /(^|[\\/])(node_modules|dist|build|__pycache__)([\\/]|$)|(^|[\\/])\.[^\\/]+([\\/]|$)/;

export function shouldWatch(rel: string): boolean {
  return !WATCH_SKIP.test(rel.replace(/\\/g, '/'));
}

export interface WatchOptions {
  /** Quiet period after the last change before a run fires. */
  debounceMs: number;
  /** Optional periodic re-check cadence (0 = off) — catches drift that does not touch files. */
  intervalMs?: number;
  /**
   * Run one pass of the loop. Returns the files the pass wrote — they are
   * removed from the mid-run change set so the loop's own repairs never
   * re-trigger it.
   */
  onRun: () => Promise<Iterable<string>>;
  log?: (msg: string) => void;
}

export class WatchSession {
  private pending = new Set<string>();
  private running = false;
  private debounceTimer?: NodeJS.Timeout;
  private intervalTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private opts: WatchOptions) {}

  /** A file (relative to the root) — or null for the whole tree — changed. */
  onChange(path: string | null): void {
    if (this.closed) return;
    // Ignored paths (build output, caches, .git) are not drift — adding
    // nothing means scheduling nothing either.
    if (path === null || shouldWatch(path)) {
      this.pending.add(path ?? '*');
      this.schedule();
    }
  }

  /** Begin: run once shortly after startup, then every intervalMs if set. */
  start(): void {
    this.schedule();
    if (this.opts.intervalMs && this.opts.intervalMs > 0) {
      this.intervalTimer = setInterval(() => this.schedule(), this.opts.intervalMs);
      this.intervalTimer.unref?.();
    }
  }

  close(): void {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
  }

  private schedule(): void {
    if (this.closed || this.running || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.run();
    }, this.opts.debounceMs);
    this.debounceTimer.unref?.();
  }

  private async run(): Promise<void> {
    // Everything that accumulated before this run is about to be handled, so
    // it is consumed here. Only changes that arrive *mid-run* can justify
    // another pass — and of those, the files this run itself wrote are the
    // loop's own echo, dropped rather than re-triggering.
    this.pending.clear();
    this.running = true;
    let touched: Iterable<string> = [];
    try {
      touched = await this.opts.onRun();
    } catch (err) {
      this.opts.log?.(`run failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
    for (const t of touched) this.pending.delete(t);
    if (this.pending.size > 0) {
      this.opts.log?.('changes arrived during the run — checking again');
      this.schedule();
    }
  }
}

// ------------------------------------------------------------- polling fallback

/**
 * A cheap fingerprint of the tree (path → mtime:size), used on platforms
 * without recursive fs.watch. Build output and caches are skipped the same
 * way the watcher skips them.
 */
export function snapshotTree(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a path that vanished mid-walk is not drift
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (!shouldWatch(childRel)) continue;
      if (e.isDirectory()) {
        walk(join(dir, e.name), childRel);
      } else if (e.isFile()) {
        try {
          const s = statSync(join(dir, e.name));
          map.set(childRel, `${s.mtimeMs}:${s.size}`);
        } catch {
          // raced with a writer — skip this file this round
        }
      }
    }
  };
  walk(root, '');
  return map;
}

/** Paths whose fingerprint differs between two snapshots. */
export function changedPaths(prev: Map<string, string>, next: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [p, sig] of next) if (prev.get(p) !== sig) changed.push(p);
  for (const p of prev.keys()) if (!next.has(p)) changed.push(p);
  return changed;
}
