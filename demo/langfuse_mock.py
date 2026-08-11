"""Minimal Langfuse-compatible mock server for keyless local demos.

Implements exactly the two endpoints the Langfuse SDKs (python v4 / js v5)
actually call, so the real SDKs — and kintsugi's tracer + audit — work
unmodified:

  POST /api/public/ingestion          store trace/span/generation events
  GET  /api/public/v2/observations    return them (ObservationV2 shape)

Plus a trace viewer page at /?trace=<id> that renders the captured trace
the way the audit reads it (settle span + ledger-joinable generations).

Stdlib only. Run:  python langfuse_mock.py [port]
"""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787

# traceId -> list of ingested events
TRACES = {}
OBS = {}  # observation id -> record


def _flatten_events(batch):
    """SDK ingestion events arrive as {type, id, timestamp, body} — the
    body carries the trace/spans/generations. Flatten into observations."""
    out = []
    for ev in batch or []:
        body = ev.get("body") or {}
        etype = (ev.get("type") or "").replace("-create", "").upper()
        # A trace event *is* the trace: its body carries the trace id in
        # `id` (and no `traceId`), unlike span/generation events.
        tid = body.get("id") if etype == "TRACE" else body.get("traceId")
        if not tid:
            continue
        if etype == "TRACE":
            rec = {
                "id": body.get("id"),
                "traceId": tid,
                "type": "TRACE",
                "name": body.get("name", "trace"),
                "input": body.get("input"),
            }
        else:
            rec = {
                "id": body.get("id"),
                "traceId": tid,
                "type": etype,  # SPAN / GENERATION
                "name": body.get("name", ""),
                "input": body.get("input"),
                "output": body.get("output"),
                "usage": body.get("usage"),
                "metadata": body.get("metadata"),
                "parentObservationId": body.get("parentObservationId"),
            }
        out.append(rec)
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            payload = {}
        if path == "/api/public/ingestion":
            batch = payload.get("batch") or []
            n = 0
            for rec in _flatten_events(batch):
                OBS[rec["id"]] = rec
                TRACES.setdefault(rec["traceId"], []).append(rec)
                n += 1
            print(f"[mock-langfuse] ingested {n} observation(s)")
            self._send(200, {"success": True, "message": "data uploaded successfully"})
        else:
            self._send(404, {"success": False, "message": f"no route {path}"})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/api/public/observations", "/api/public/v2/observations"):
            q = parse_qs(parsed.query)
            trace_id = (q.get("traceId") or [None])[0]
            records = TRACES.get(trace_id, []) if trace_id else [
                r for rs in TRACES.values() for r in rs
            ]
            # Filter to the fields the audit reads, but satisfy the SDK
            # models' required fields (startTime, level) so the python v2
            # client's pydantic validation passes.
            slim = []
            for r in records:
                slim.append({
                    "id": r["id"],
                    "traceId": r.get("traceId"),
                    "name": r.get("name"),
                    "type": r.get("type"),
                    "startTime": r.get("startTime") or "2026-01-01T00:00:00.000Z",
                    "level": "DEFAULT",
                    "input": r.get("input"),
                    "output": r.get("output"),
                    "metadata": r.get("metadata"),
                    "usage": r.get("usage"),
                })
            print(f"[mock-langfuse] observations for {trace_id or '*'} -> {len(slim)}")
            self._send(200, {"data": slim, "meta": {
                "totalItems": len(slim), "page": 1, "limit": 1000, "totalPages": 1}})
        elif path == "/":
            q = parse_qs(parsed.query)
            trace_id = (q.get("trace") or [""])[0]
            self._send_html(trace_id)
        else:
            self._send(404, {"success": False})

    def _send_html(self, trace_id):
        html = TRACE_VIEWER
        if trace_id:
            html = html.replace("const TRACE_ID = '';", f"const TRACE_ID = {json.dumps(trace_id)};")
            html = html.replace('const TRACE_ID = "";', f"const TRACE_ID = {json.dumps(trace_id)};")
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


TRACE_VIEWER = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>kintsugi trace</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b1020; color: #e6edf3; margin: 0; padding: 24px; }
  h1 { font-size: 15px; color: #8b98a9; font-weight: 600; letter-spacing: .02em; margin: 0 0 4px; }
  h2 { font-size: 12px; color: #5c6a7d; font-weight: 500; margin: 0 0 20px; }
  .card { background: #111827; border: 1px solid #233043; border-radius: 8px; padding: 16px 18px; margin-bottom: 10px; }
  .card.trace { border-left: 3px solid #6366f1; }
  .card.span { border-left: 3px solid #22c55e; }
  .card.generation { border-left: 3px solid #f59e0b; }
  .row { display: flex; gap: 14px; align-items: baseline; font-size: 12px; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: .06em; }
  .b-TRACE { background: #312e81; color: #c7d2fe; }
  .b-SPAN { background: #14532d; color: #86efac; }
  .b-GENERATION { background: #78350f; color: #fde68a; }
  .name { color: #e6edf3; font-weight: 600; }
  .meta { color: #8b98a9; }
  .fp { color: #7dd3fc; }
  .outcome { padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .o-committed { background: #052e16; color: #4ade80; }
  .o-regressed, .o-unverifiable { background: #450a0a; color: #f87171; }
  .o-quarantined { background: #3b0764; color: #d8b4fe; }
  pre { background: #0b1020; border: 1px solid #1c2740; border-radius: 6px; padding: 10px 12px; font-size: 11px; overflow-x: auto; color: #c9d4e3; }
  .cost { color: #fbbf24; font-weight: 600; }
  .lbl { color: #5c6a7d; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-top: 10px; }
</style></head><body>
<h1>kintsugi — trace</h1>
<h2>mock Langfuse · trace <span class="fp" id="tid"></span></h2>
<div id="root">loading…</div>
<script>
const TRACE_ID = '';
const PRICE = { in: 5 / 1e6, out: 25 / 1e6 };
function cost(i, o) { return i * PRICE.in + o * PRICE.out; }
function esc(s) {
  const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML;
}
function badge(type) { return `<span class="badge b-${type}">${type}</span>`; }
function attemptRow(a) {
  const cls = a.outcome === 'committed' ? 'o-committed' : (a.outcome === 'quarantined' ? 'o-quarantined' : 'o-regressed');
  return `<div class="row"><span class="outcome ${cls}">${esc(a.outcome)}</span>
    <span class="fp">${esc(a.fingerprint)}</span>
    <span class="meta">${esc(a.check || '')} · ${esc((a.patch && a.patch.rationale) || '')}</span>
    <span class="meta">provider=${a.provider ? 'model' : 'rules'}</span></div>`;
}
async function main() {
  const id = TRACE_ID || location.hash.slice(1);
  document.getElementById('tid').textContent = id;
  if (!id) { document.getElementById('root').innerHTML = 'no trace id — open /?trace=&lt;id&gt;'; return; }
  const res = await fetch('/api/public/v2/observations?traceId=' + encodeURIComponent(id));
  const { data } = await res.json();
  const settle = data.find(o => o.name === 'settle');
  const gens = data.filter(o => (o.type || '').toUpperCase() === 'GENERATION');
  const others = data.filter(o => o.name !== 'settle' && (o.type || '').toUpperCase() !== 'GENERATION');
  let html = `<div class="card trace"><div class="row">${badge('TRACE')}
    <span class="name">kintsugi</span>
    <span class="meta">${data.length} observation(s) · trace ${esc(id)}</span></div></div>`;
  html += `<div class="card span"><div class="row">${badge('SPAN')} <span class="name">settle</span>
    <span class="meta">${esc((settle && settle.input && settle.input.status) || '')} · ${esc((settle && settle.input && settle.input.iterations) || 0)} iteration(s)</span></div>`;
  if (settle && settle.input && settle.input.attempts) {
    html += `<div class="lbl">attempts — ledger-joined</div>` + settle.input.attempts.map(attemptRow).join('');
  }
  html += `</div>`;
  const usageByFp = {};
  for (const g of gens) {
    const fp = g.input && g.input.fingerprint;
    if (!fp) continue;
    usageByFp[fp] = usageByFp[fp] || { input: 0, output: 0 };
    usageByFp[fp].input += (g.usage && g.usage.input) || 0;
    usageByFp[fp].output += (g.usage && g.usage.output) || 0;
  }
  for (const g of gens) {
    const fp = g.input && g.input.fingerprint;
    const u = usageByFp[fp] || { input: 0, output: 0 };
    html += `<div class="card generation"><div class="row">${badge('GENERATION')}
      <span class="name">${esc(g.name)}</span>
      <span class="fp">${esc(fp || '')}</span>
      <span class="meta">${u.input} in · ${u.output} out</span>
      <span class="cost">$${cost(u.input, u.output).toFixed(6)}</span></div>
      <pre>${esc(JSON.stringify(g.input || {}, null, 1))}</pre></div>`;
  }
  for (const o of others) {
    html += `<div class="card span"><div class="row">${badge('SPAN')} <span class="name">${esc(o.name)}</span>
      <span class="meta">${o.usage ? (o.usage.input + ' in · ' + o.usage.output + ' out') : ''}</span></div></div>`;
  }
  document.getElementById('root').innerHTML = html;
}
main();
</script></body></html>
"""


if __name__ == "__main__":
    print(f"[mock-langfuse] listening on http://127.0.0.1:{PORT}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
