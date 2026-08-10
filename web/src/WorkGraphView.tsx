import { useMemo } from 'react';

type NodeStatus = 'pending' | 'running' | 'ok' | 'invalid' | 'failed' | 'skipped';

interface WorkGraph {
  nodes: { id: string; job: string; dependsOn: string[] }[];
  layers: string[][];
  status: Record<string, NodeStatus>;
  ms: Record<string, number>;
}

/**
 * The work graph, drawn as it executes.
 *
 * Laid out by dependency depth: one column per layer, so a column with more
 * than one node is work running concurrently. The diamond is the point —
 * seeing three observers side by side and a single serial tail is what makes
 * the difference between sequence and dependency legible at a glance.
 */
export function WorkGraphView({ work }: { work?: WorkGraph }) {
  const layout = useMemo(() => {
    if (!work?.nodes.length) return null;

    const COL = 132;
    const ROW = 46;
    const PAD_X = 12;
    const PAD_Y = 18;
    const tallest = Math.max(...work.layers.map((l) => l.length));
    const width = PAD_X * 2 + (work.layers.length - 1) * COL + 96;
    const height = PAD_Y * 2 + Math.max(1, tallest) * ROW;

    const pos = new Map<string, { x: number; y: number }>();
    work.layers.forEach((layer, ci) => {
      const offset = (tallest - layer.length) / 2;
      layer.forEach((id, ri) => {
        pos.set(id, {
          x: PAD_X + ci * COL,
          y: PAD_Y + (offset + ri) * ROW + ROW / 2,
        });
      });
    });

    return { pos, width, height };
  }, [work]);

  if (!work || !layout) {
    return <div className="graph-empty">The work graph appears when the first iteration plans it.</div>;
  }

  const short = (id: string) => id.replace(/^observe:/, '').replace(/^critic:/, 'check ');

  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="workgraph" role="img"
      aria-label="Work graph: jobs by dependency depth, columns run concurrently">
      {/* real dependencies only — a drawn edge means data actually flows */}
      {work.nodes.flatMap((n) =>
        n.dependsOn.map((d) => {
          const a = layout.pos.get(d);
          const b = layout.pos.get(n.id);
          if (!a || !b) return null;
          const mx = (a.x + 84 + b.x) / 2;
          return (
            <path
              key={`${d}->${n.id}`}
              className="w-edge"
              d={`M ${a.x + 84} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`}
            />
          );
        }),
      )}

      {work.nodes.map((n) => {
        const p = layout.pos.get(n.id);
        if (!p) return null;
        const status = work.status[n.id] ?? 'pending';
        const ms = work.ms[n.id];
        return (
          <g key={n.id} className={`w-node ${status}`}>
            <rect x={p.x} y={p.y - 13} width={84} height={26} rx={6} />
            <text x={p.x + 42} y={p.y + 4}>{short(n.id)}</text>
            <title>
              {n.job}
              {'\n'}status: {status}
              {ms !== undefined ? `\n${ms}ms` : ''}
              {n.dependsOn.length ? `\nneeds: ${n.dependsOn.join(', ')}` : '\nno dependencies — starts immediately'}
            </title>
          </g>
        );
      })}
    </svg>
  );
}
