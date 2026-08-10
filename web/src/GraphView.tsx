import { useMemo } from 'react';

interface Node { id: string; kind: string; label: string; unmeasurable?: string }
interface Graph { nodes: Record<string, Node>; edges: { from: string; to: string }[] }
interface Finding { nodeId: string; severity: string }

/**
 * Radial layout: surfaces on an inner ring, their signals fanned out around
 * each one. Deterministic rather than force-directed, so a node does not
 * move between iterations — watching a node change colour in place is the
 * whole reason to look at this.
 */
export function GraphView({ graph, findings }: { graph: Graph; findings: Finding[] }) {
  const severityOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of findings) {
      const cur = m.get(f.nodeId);
      const rank = { blocker: 0, major: 1, minor: 2 } as Record<string, number>;
      if (!cur || rank[f.severity] < rank[cur]) m.set(f.nodeId, f.severity);
    }
    return m;
  }, [findings]);

  const layout = useMemo(() => {
    const all = Object.values(graph.nodes);
    const surfaces = all.filter((n) => n.kind === 'surface');
    const placed = new Map<string, { x: number; y: number; r: number; n: Node }>();
    const W = 520, H = 400, CX = W / 2, CY = H / 2;

    surfaces.forEach((s, si) => {
      const sa = surfaces.length === 1
        ? -Math.PI / 2
        : (si / surfaces.length) * Math.PI * 2 - Math.PI / 2;
      const sr = surfaces.length === 1 ? 0 : 92;
      const sx = CX + sr * Math.cos(sa);
      const sy = CY + sr * Math.sin(sa);
      placed.set(s.id, { x: sx, y: sy, r: 9, n: s });

      const kids = all.filter((n) => n.kind === 'signal' && n.id.startsWith(s.id + '::'));
      kids.forEach((k, ki) => {
        // Fan the children into the sector belonging to this surface.
        const spread = Math.min(Math.PI * 1.7, 0.24 * kids.length);
        const a = sa - spread / 2 + (kids.length === 1 ? spread / 2 : (ki / (kids.length - 1)) * spread);
        const rr = 118;
        placed.set(k.id, { x: sx + rr * Math.cos(a), y: sy + rr * Math.sin(a), r: 4.5, n: k });
      });
    });

    return { placed, W, H };
  }, [graph]);

  if (!Object.keys(graph.nodes).length) {
    return <div className="graph-empty">The graph builds itself on the first observe pass.</div>;
  }

  return (
    <svg viewBox={`0 0 ${layout.W} ${layout.H}`} className="graphview" role="img"
      aria-label="UI graph: surfaces and their measured signals">
      {graph.edges.map((e, i) => {
        const a = layout.placed.get(e.from);
        const b = layout.placed.get(e.to);
        if (!a || !b) return null;
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="g-edge" />;
      })}

      {[...layout.placed.values()].map(({ x, y, r, n }) => {
        const sev = severityOf.get(n.id);
        const cls = [
          'g-node',
          n.kind,
          sev ? `sev-${sev}` : '',
          n.unmeasurable ? 'unmeasurable' : '',
        ].filter(Boolean).join(' ');
        return (
          <g key={n.id} className={cls}>
            <circle cx={x} cy={y} r={r} />
            <title>
              {n.label}
              {sev ? ` — ${sev}` : ''}
              {n.unmeasurable ? ` — not measurable: ${n.unmeasurable}` : ''}
            </title>
            {n.kind === 'surface' && <text x={x} y={y - 16}>{n.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}
