import { useEffect, useMemo, useRef, useState } from 'react';
import { LoopRing } from './LoopRing.js';
import { GraphView } from './GraphView.js';
import { WorkGraphView } from './WorkGraphView.js';

type Phase = 'observe' | 'diagnose' | 'repair' | 'verify' | 'settle';

interface LoopEvent {
  runId: string;
  iteration: number;
  phase: Phase;
  at: string;
  message: string;
  data?: any;
}

interface Finding {
  fingerprint: string;
  nodeId: string;
  detector: string;
  severity: 'blocker' | 'major' | 'minor';
  summary: string;
}

interface RunState {
  id: string;
  graph: { nodes: Record<string, any>; edges: any[] };
  work?: {
    nodes: { id: string; job: string; dependsOn: string[] }[];
    layers: string[][];
    status: Record<string, any>;
    ms: Record<string, number>;
  };
  findings: Finding[];
  attempts: any[];
  iteration: number;
  status: string;
}

export default function App() {
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [state, setState] = useState<RunState | null>(null);
  const [running, setRunning] = useState(false);
  const [target, setTarget] = useState('http://localhost:5173');
  const [sourceRoot, setSourceRoot] = useState('');
  const [routes, setRoutes] = useState('/');
  const [error, setError] = useState<string | null>(null);
  const streamEnd = useRef<HTMLDivElement>(null);

  // Live loop events.
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (m) => setEvents((prev) => [...prev.slice(-300), JSON.parse(m.data)]);
    return () => es.close();
  }, []);

  // Run state, polled slowly — the events carry the interesting detail, this
  // is only for the graph and the tallies.
  useEffect(() => {
    const tick = async () => {
      const r = await fetch('/api/state').then((x) => x.json()).catch(() => null);
      if (r) { setState(r.state); setRunning(r.running); }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    streamEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length]);

  const phase = events.length ? events[events.length - 1].phase : null;
  const iteration = events.length ? events[events.length - 1].iteration : 0;

  const tally = useMemo(() => {
    const f = state?.findings ?? [];
    return {
      blocker: f.filter((x) => x.severity === 'blocker').length,
      major: f.filter((x) => x.severity === 'major').length,
      minor: f.filter((x) => x.severity === 'minor').length,
    };
  }, [state]);

  const committed = (state?.attempts ?? []).filter((a) => a.outcome === 'committed');
  const rejected = (state?.attempts ?? []).filter((a) => a.outcome !== 'committed');

  // Withheld on purpose, not failed to fix. Deduped by token so one shared
  // token failing on six surfaces reads as one decision, not six.
  const escalations = useMemo(() => {
    const byToken = new Map<string, any>();
    for (const a of state?.attempts ?? []) {
      if (a.patch?.scope !== 'token' && a.patch?.scope !== 'global') continue;
      const key = a.patch.find;
      if (!byToken.has(key)) byToken.set(key, a.patch);
    }
    return [...byToken.values()];
  }, [state]);

  async function start() {
    setError(null);
    setEvents([]);
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target,
        sourceRoot,
        routes: routes.split(',').map((r) => r.trim()).filter(Boolean),
        maxIterations: 8,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      setError(body.error ?? 'Failed to start');
      return;
    }
    setRunning(true);
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>Kintsugi</h1>
            <p>Self-healing UI — a graph, repaired in verified loops</p>
          </div>
        </div>
        <div className="status" data-state={running ? 'running' : state?.status ?? 'idle'}>
          {running ? `iteration ${iteration}` : state?.status ?? 'idle'}
        </div>
      </header>

      <section className="controls">
        <label>
          <span>Target app</span>
          <input value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder="http://localhost:5173" />
        </label>
        <label>
          <span>Source root</span>
          <input value={sourceRoot} onChange={(e) => setSourceRoot(e.target.value)}
            placeholder="path the healer may edit" />
        </label>
        <label className="narrow">
          <span>Routes</span>
          <input value={routes} onChange={(e) => setRoutes(e.target.value)} placeholder="/, /settings" />
        </label>
        <button onClick={start} disabled={running || !sourceRoot}>
          {running ? 'Running…' : 'Start loop'}
        </button>
      </section>

      {error && <div className="error">{error}</div>}

      <main>
        <div className="panel loop">
          <h2>Loop</h2>
          <LoopRing active={phase} />
          <dl className="counts">
            <div><dt>Committed</dt><dd className="good">{committed.length}</dd></div>
            <div><dt>Reverted</dt><dd className="warn">{rejected.length}</dd></div>
            <div><dt>Outstanding</dt><dd>{state?.findings.length ?? 0}</dd></div>
          </dl>
          <p className="note">
            A patch is kept only if re-observing shows the finding gone and
            nothing new in its place. Everything else is reverted and recorded.
          </p>
        </div>

        <div className="panel graph">
          <h2>
            Work graph
            <small>
              {state?.work
                ? `${state.work.layers.length} layers · ${state.work.layers.map((l) => l.length).join('→')}`
                : 'not planned yet'}
            </small>
          </h2>
          <WorkGraphView work={state?.work} />
          <p className="note">
            One column per dependency depth. A column with more than one node is
            work running at the same time; the single-file tail is serial because
            two patches at once would make the verification meaningless.
          </p>

          <h2 className="stacked">UI graph <small>{Object.keys(state?.graph.nodes ?? {}).length} nodes</small></h2>
          <GraphView graph={state?.graph ?? { nodes: {}, edges: [] }} findings={state?.findings ?? []} />
        </div>

        <div className="panel stream">
          <h2>Stream</h2>
          <ol className="events">
            {events.map((e, i) => (
              <li key={i} data-phase={e.phase}>
                <span className="badge">{e.phase}</span>
                <span className="msg">{e.message}</span>
              </li>
            ))}
            {!events.length && <li className="empty">No run yet.</li>}
          </ol>
          <div ref={streamEnd} />
        </div>

        {escalations.length > 0 && (
          <div className="panel escalations">
            <h2>
              Your call
              <small>{escalations.length} change{escalations.length > 1 ? 's' : ''} withheld</small>
            </h2>
            <p className="note">
              Each of these clears its measurement. None was applied, because
              each reaches past the defect — a shared design token, or a bare
              element rule — into the rest of the product. Verification cannot
              catch that: the finding really does clear, and the damage lands
              somewhere the loop was not looking.
            </p>
            <ul>
              {escalations.map((p) => (
                <li key={p.id}>
                  <code>{p.find}</code>
                  <span className="arrow">→</span>
                  <code className="proposed">{p.replace}</code>
                  {typeof p.blastRadius === 'number' && (
                    <span className="radius">{p.blastRadius} use site{p.blastRadius === 1 ? '' : 's'}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="panel findings">
          <h2>
            Findings
            <small>
              {tally.blocker} blocker · {tally.major} major · {tally.minor} minor
            </small>
          </h2>
          <ul>
            {(state?.findings ?? []).map((f) => (
              <li key={f.fingerprint} data-sev={f.severity}>
                <span className="sev">{f.severity}</span>
                <div>
                  <strong>{f.detector}</strong>
                  <p>{f.summary}</p>
                </div>
              </li>
            ))}
            {!state?.findings.length && <li className="empty">Nothing outstanding.</li>}
          </ul>
        </div>
      </main>
    </div>
  );
}
