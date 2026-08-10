import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { Loop } from './loop.js';
import type { LoopEvent, RunConfig, RunState } from './types.js';

/**
 * API + dashboard host.
 *
 * Loop progress is pushed over SSE rather than polled, because the useful
 * thing to watch is the sequence of phases as they happen — a poll shows you
 * the state after the fact and loses the ordering that explains it.
 */

const PORT = Number(process.env.PORT ?? 4180);
const WEB_DIST = resolve(import.meta.dirname, '../web/dist');

const clients = new Set<import('node:http').ServerResponse>();
const history: LoopEvent[] = [];
let current: RunState | null = null;
/**
 * Held for the duration of a run so /api/state can report the graph as it is
 * being built. Reporting the snapshot taken at start would leave the graph
 * empty until the run finished, which is precisely when nobody needs it.
 */
let active: Loop | null = null;
let running = false;

const broadcast = (event: LoopEvent) => {
  history.push(event);
  if (history.length > 500) history.shift();
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(payload);
};

const json = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // ---- events ------------------------------------------------------------
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Replay so a dashboard opened mid-run is not staring at a blank page.
    for (const e of history) res.write(`data: ${JSON.stringify(e)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // ---- current state -----------------------------------------------------
  if (url.pathname === '/api/state') {
    return json(res, 200, { running, state: active ? active.snapshot : current });
  }

  // ---- start a run -------------------------------------------------------
  if (url.pathname === '/api/run' && req.method === 'POST') {
    if (running) return json(res, 409, { error: 'A run is already in progress' });

    const body = await readBody(req);
    let config: RunConfig;
    try {
      config = normaliseConfig(body);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }

    running = true;
    history.length = 0;
    const loop = new Loop(config, broadcast);
    active = loop;
    current = loop.snapshot;

    // Respond immediately; the run reports itself over SSE.
    json(res, 202, { runId: current.id });

    loop.run()
      .then((state) => { current = state; })
      .catch((err) => {
        broadcast({
          runId: current?.id ?? '-', iteration: 0, phase: 'settle',
          at: new Date().toISOString(),
          message: `Run crashed: ${err.message}`,
        });
      })
      .finally(() => { running = false; active = null; });
    return;
  }

  // ---- dashboard ---------------------------------------------------------
  if (!existsSync(WEB_DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    return res.end('Dashboard not built yet. Run: npm run build:web');
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = join(WEB_DIST, rel);
  // Serve index.html for unknown paths so client-side routing works, but
  // never escape the dist directory.
  const safe = file.startsWith(WEB_DIST) && existsSync(file)
    ? file
    : join(WEB_DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream' });
  res.end(readFileSync(safe));
});

function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((ok) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { ok(JSON.parse(raw || '{}')); } catch { ok({}); }
    });
  });
}

function normaliseConfig(body: any): RunConfig {
  if (!body.target) throw new Error('target is required (base URL of the app to repair)');
  if (!body.sourceRoot) throw new Error('sourceRoot is required (repo the healer may edit)');
  return {
    target: String(body.target),
    routes: Array.isArray(body.routes) && body.routes.length ? body.routes.map(String) : ['/'],
    sourceRoot: resolve(String(body.sourceRoot)),
    maxIterations: Number(body.maxIterations ?? 8),
    dryRun: Boolean(body.dryRun ?? false),
    allowTokens: Boolean(body.allowTokens ?? false),
    attach: body.attach ? String(body.attach) : undefined,
  };
}

server.listen(PORT, () => {
  console.log(`kintsugi → http://localhost:${PORT}`);
});
