/**
 * The work graph.
 *
 * A node is one unit of work with one defined input and one defined output.
 * An edge is a genuine dependency — the second node needs what the first
 * produced. Not merely "runs after": that distinction is the whole point,
 * because everything without a real incoming edge can start immediately.
 *
 * Every node declares an output contract. A node whose result does not match
 * its shape is rejected and retried rather than passed downstream, so a
 * malformed result fails at its source instead of corrupting the node that
 * consumes it.
 */

export interface NodeContext {
  /** Outputs of this node's declared dependencies, keyed by node id. */
  deps: Record<string, unknown>;
  /** Reports progress without coupling nodes to any particular transport. */
  emit: (message: string, data?: unknown) => void;
  signal?: AbortSignal;
}

export interface WorkNode<Out = unknown> {
  id: string;
  /** Human-readable job description — one task, nothing else. */
  job: string;
  /**
   * Real dependencies only. If this node does not consume what the other
   * produced, leave the edge out and let them run at the same time.
   */
  dependsOn: string[];
  run: (ctx: NodeContext) => Promise<Out>;
  /** The output contract. Returning false rejects the result. */
  validate: (out: unknown) => boolean;
  /** Attempts before the node is declared failed. Default 2. */
  retries?: number;
}

export interface NodeResult {
  id: string;
  status: 'ok' | 'invalid' | 'failed' | 'skipped';
  output?: unknown;
  attempts: number;
  ms: number;
  error?: string;
}

export interface RunReport {
  results: Record<string, NodeResult>;
  /** Execution layers: everything in a layer ran concurrently. */
  layers: string[][];
}

/**
 * Group nodes into layers by dependency depth. Everything in a layer has no
 * dependency on anything else in that layer, so the layer runs concurrently.
 * This is the fan-out; the next layer's fan-in waits only for the slowest
 * member, which is the only unavoidable wait.
 */
export function plan(nodes: WorkNode[]): string[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (!byId.has(d)) throw new Error(`Node ${n.id} depends on unknown node ${d}`);
    }
  }

  const layers: string[][] = [];
  const done = new Set<string>();

  while (done.size < nodes.length) {
    const layer = nodes
      .filter((n) => !done.has(n.id) && n.dependsOn.every((d) => done.has(d)))
      .map((n) => n.id);

    if (layer.length === 0) {
      const stuck = nodes.filter((n) => !done.has(n.id)).map((n) => n.id);
      throw new Error(`Dependency cycle among: ${stuck.join(', ')}`);
    }
    layer.forEach((id) => done.add(id));
    layers.push(layer);
  }

  return layers;
}

export type NodeStatus = 'pending' | 'running' | 'ok' | 'invalid' | 'failed' | 'skipped';

/** The graph's shape, for anyone who wants to look at it rather than run it. */
export interface GraphPlan {
  nodes: { id: string; job: string; dependsOn: string[] }[];
  layers: string[][];
}

export interface ExecuteOptions {
  emit?: (nodeId: string, message: string, data?: unknown) => void;
  /** Called once, before anything runs, with the resolved execution plan. */
  onPlan?: (plan: GraphPlan) => void;
  /** Called on every node state transition, so progress is watchable live. */
  onNodeStatus?: (id: string, status: NodeStatus, ms?: number) => void;
  signal?: AbortSignal;
}

/** Run the graph layer by layer, concurrently within each layer. */
export async function execute(
  nodes: WorkNode[],
  opts: ExecuteOptions = {},
): Promise<RunReport> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layers = plan(nodes);
  const results: Record<string, NodeResult> = {};

  opts.onPlan?.({
    nodes: nodes.map((n) => ({ id: n.id, job: n.job, dependsOn: n.dependsOn })),
    layers,
  });

  for (const layer of layers) {
    await Promise.all(
      layer.map(async (id) => {
        const node = byId.get(id)!;
        opts.onNodeStatus?.(id, 'running');

        // A node whose dependency failed cannot run — its input does not
        // exist. Skipping is honest; running it on partial input is not.
        const broken = node.dependsOn.filter((d) => results[d]?.status !== 'ok');
        if (broken.length) {
          results[id] = {
            id, status: 'skipped', attempts: 0, ms: 0,
            error: `dependency not satisfied: ${broken.join(', ')}`,
          };
          opts.onNodeStatus?.(id, 'skipped', 0);
          return;
        }

        const deps = Object.fromEntries(
          node.dependsOn.map((d) => [d, results[d].output]),
        );
        const started = Date.now();
        const limit = node.retries ?? 2;
        let lastError = '';

        for (let attempt = 1; attempt <= limit; attempt++) {
          if (opts.signal?.aborted) {
            results[id] = { id, status: 'failed', attempts: attempt, ms: Date.now() - started, error: 'aborted' };
            opts.onNodeStatus?.(id, 'failed', Date.now() - started);
            return;
          }
          try {
            const out = await node.run({
              deps,
              emit: (m, d) => opts.emit?.(id, m, d),
              signal: opts.signal,
            });

            if (!node.validate(out)) {
              // The article's rule, enforced: a result that does not match
              // the declared shape is rejected and retried, never handed on.
              lastError = 'output did not match the declared shape';
              opts.emit?.(id, `attempt ${attempt}: ${lastError} — retrying`);
              continue;
            }

            results[id] = { id, status: 'ok', output: out, attempts: attempt, ms: Date.now() - started };
            opts.onNodeStatus?.(id, 'ok', Date.now() - started);
            return;
          } catch (err) {
            lastError = (err as Error).message;
            opts.emit?.(id, `attempt ${attempt} threw: ${lastError}`);
          }
        }

        const status = lastError.startsWith('output did not match') ? 'invalid' : 'failed';
        results[id] = {
          id, status, attempts: limit, ms: Date.now() - started, error: lastError,
        };
        opts.onNodeStatus?.(id, status, Date.now() - started);
      }),
    );
  }

  return { results, layers };
}
