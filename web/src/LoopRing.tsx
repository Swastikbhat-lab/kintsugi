const PHASES = ['observe', 'diagnose', 'repair', 'verify', 'settle'] as const;
type Phase = (typeof PHASES)[number];

const R = 78;
const CX = 110;
const CY = 110;

/**
 * The cycle itself, drawn. Verify sits opposite repair deliberately — it is
 * the phase that decides whether a repair survives, and showing it as a
 * gate rather than a footnote is most of the point of the diagram.
 */
export function LoopRing({ active }: { active: Phase | null }) {
  const pos = (i: number) => {
    // Start at the top and go clockwise.
    const a = (i / PHASES.length) * Math.PI * 2 - Math.PI / 2;
    return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
  };

  return (
    <svg viewBox="0 0 220 220" className="ring" role="img"
      aria-label={`Loop phases; current phase ${active ?? 'idle'}`}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
        </marker>
      </defs>

      {PHASES.map((_, i) => {
        const from = pos(i);
        const to = pos((i + 1) % PHASES.length);
        // Bow each connector outward so the ring reads as a cycle rather
        // than a pentagon.
        const mx = (from.x + to.x) / 2;
        const my = (from.y + to.y) / 2;
        const dx = mx - CX;
        const dy = my - CY;
        const k = 1.18;
        return (
          <path
            key={i}
            className="edge"
            d={`M ${from.x} ${from.y} Q ${CX + dx * k} ${CY + dy * k} ${to.x} ${to.y}`}
            markerEnd="url(#arrow)"
          />
        );
      })}

      {PHASES.map((p, i) => {
        const { x, y } = pos(i);
        const on = active === p;
        return (
          <g key={p} className={on ? 'node on' : 'node'}>
            <circle cx={x} cy={y} r={on ? 15 : 11} />
            <text x={x} y={y + 30}>{p}</text>
          </g>
        );
      })}
    </svg>
  );
}
