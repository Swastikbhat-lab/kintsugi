"""Minimal Langfuse-compatible mock server for keyless local demos.

Implements exactly the two endpoints the Langfuse SDKs (python v2) actually
call, so the real SDK — and kintsugi's tracer + audit — work unmodified:

  POST /api/public/ingestion          store trace/span/generation events
  GET  /api/public/observations       return them (Observation shape)

Plus a full observability dashboard at `/` (deep-link `/?trace=<id>`)
that renders the captured traces the way the audit reads them: runs list,
run stats, a phase timeline, the ledger-joined attempts table, and the
per-finding cost table.

Stdlib only. Run:  python langfuse_mock.py [port]
"""

import json
import re
import sys
import time
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
        stamp = ev.get("timestamp") or body.get("timestamp")
        rec = {
            "id": body.get("id"),
            "traceId": tid,
            "type": etype,
            "name": body.get("name", ""),
            "input": body.get("input"),
            "output": body.get("output"),
            "usage": body.get("usage"),
            "metadata": body.get("metadata"),
            "parentObservationId": body.get("parentObservationId"),
            "startTime": stamp,
        }
        if etype == "TRACE":
            rec["name"] = body.get("name", "kintsugi")
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

    def _send_html(self, html):
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
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
                    "startTime": r.get("startTime") or "1970-01-01T00:00:00.000Z",
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
            html = DASHBOARD
            if trace_id:
                html = html.replace("const TRACE_ID = '';", f"const TRACE_ID = {json.dumps(trace_id)};")
            self._send_html(html)
        else:
            self._send(404, {"success": False})


DASHBOARD = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kintsugi · observability</title>
<style>
:root{
  --bg:#070a12; --bg-soft:#0b1020; --panel:#0f1526; --panel-2:#131b2e;
  --border:#1d2840; --border-soft:#16203a;
  --text:#e9eef8; --muted:#8d98ad; --faint:#5d6b80;
  --gold:#f5c044; --green:#3ddc97; --red:#f8776f; --violet:#a78bfa;
  --blue:#61a6fa; --amber:#fbbf24; --cyan:#5eead4;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:var(--bg); color:var(--text); font-family:var(--sans); font-size:14px;
  -webkit-font-smoothing:antialiased; overflow:hidden;
}
body::before{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:0;
  background:
    radial-gradient(700px 340px at 12% -8%, rgba(245,192,68,.07), transparent 60%),
    radial-gradient(800px 420px at 95% -5%, rgba(97,166,250,.06), transparent 60%),
    radial-gradient(500px 300px at 50% 110%, rgba(167,139,250,.04), transparent 60%);
}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#1e2a45;border-radius:6px;border:2px solid var(--bg)}
::-webkit-scrollbar-thumb:hover{background:#2a3a5e}
::-webkit-scrollbar-track{background:transparent}

/* ---------- layout ---------- */
.app{display:grid;grid-template-columns:280px 1fr;height:100vh;position:relative;z-index:1}
.topbar{
  grid-column:1/3; display:flex; align-items:center; gap:16px;
  padding:0 20px; height:56px; border-bottom:1px solid var(--border);
  background:rgba(9,13,24,.85); backdrop-filter:blur(8px); position:relative; z-index:2;
}
.logo{display:flex;align-items:center;gap:10px;user-select:none}
.logo-mark{
  width:26px;height:26px;border-radius:8px;flex:none;
  background:linear-gradient(135deg,#f5c044,#d99a2b);
  display:grid;place-items:center;color:#1a1405;font-weight:800;font-size:13px;
  box-shadow:0 0 0 1px rgba(245,192,68,.4), 0 4px 14px -4px rgba(245,192,68,.5);
}
.logo-name{font-weight:700;letter-spacing:.01em;font-size:15px}
.logo-name span{color:var(--gold)}
.topbar-sub{color:var(--faint);font-size:12px;font-weight:500;letter-spacing:.02em}
.spacer{flex:1}
.btn{
  display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:8px;
  border:1px solid var(--border);background:var(--panel);color:var(--text);
  font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:all .15s;
}
.btn:hover{border-color:#2c3c5f;background:var(--panel-2);transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.btn.primary{
  background:linear-gradient(135deg,#f5c044,#e5ab31);color:#1a1405;border-color:rgba(245,192,68,.5);
  box-shadow:0 3px 12px -3px rgba(245,192,68,.4);
}
.btn.primary:hover{filter:brightness(1.06)}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}
.b-TRACE{background:rgba(97,166,250,.14);color:var(--blue)}
.b-SPAN{background:rgba(61,220,151,.13);color:var(--green)}
.b-GENERATION{background:rgba(251,191,36,.14);color:var(--amber)}
.b-EVENT{background:rgba(94,234,212,.13);color:var(--cyan)}
.bg-committed{background:rgba(61,220,151,.15);color:var(--green)}
.bg-reverted,.bg-regressed{background:rgba(248,119,111,.15);color:var(--red)}
.bg-quarantined,.bg-escalated{background:rgba(167,139,250,.16);color:var(--violet)}
.bg-ineffective{background:rgba(251,191,36,.15);color:var(--amber)}
.bg-rules{background:rgba(141,152,173,.16);color:var(--muted)}
.bg-model{background:rgba(97,166,250,.16);color:var(--blue)}

/* ---------- sidebar ---------- */
.sidebar{
  border-right:1px solid var(--border);background:rgba(11,16,32,.6);
  display:flex;flex-direction:column;min-height:0;
}
.sidebar-head{padding:16px 16px 10px;font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--faint);text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}
.run-count{color:var(--gold);font-weight:800}
.run-list{flex:1;overflow-y:auto;padding:0 10px 16px}
.run-item{
  padding:10px 12px;border-radius:10px;border:1px solid transparent;cursor:pointer;
  margin-bottom:6px;transition:all .12s;position:relative;
}
.run-item:hover{background:var(--panel)}
.run-item.active{background:var(--panel-2);border-color:var(--border)}
.run-item.active::before{content:"";position:absolute;left:-10px;top:10px;bottom:10px;width:3px;border-radius:3px;background:var(--gold)}
.run-item .r-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.run-item .r-name{font-weight:600;font-size:13px}
.run-item .r-time{font-size:11px;color:var(--faint);font-family:var(--mono)}
.run-item .r-stats{display:flex;gap:10px;margin-top:7px;align-items:center;font-size:11px;color:var(--muted)}
.run-item .r-status{display:inline-flex;align-items:center;gap:4px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint)}
.dot.converged{background:var(--green);box-shadow:0 0 8px rgba(61,220,151,.7)}
.dot.failed,.dot.regressed{background:var(--red)}
.dot.quarantined{background:var(--violet)}
.empty-side{padding:20px 16px;color:var(--faint);font-size:12.5px;line-height:1.6}

/* ---------- main ---------- */
.main{overflow-y:auto;min-height:0;padding:20px 24px 60px}
.main-head{display:flex;align-items:baseline;gap:12px;margin-bottom:4px}
.main-head h1{font-size:19px;font-weight:700;letter-spacing:-.01em}
.main-head .tid{font-family:var(--mono);font-size:12px;color:var(--faint)}
.main-head .tid::before{content:"· ";color:var(--gold)}
.crumb{color:var(--faint);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px}
.crumb b{color:var(--gold)}

.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 20px}
.stat{
  background:linear-gradient(180deg,var(--panel),rgba(15,21,38,.6));border:1px solid var(--border);
  border-radius:12px;padding:14px 16px;position:relative;overflow:hidden;
}
.stat::after{content:"";position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(245,192,68,.35),transparent)}
.stat .s-label{font-size:10.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--faint)}
.stat .s-value{font-size:22px;font-weight:800;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums}
.stat .s-value.gold{color:var(--gold)}
.stat .s-value.green{color:var(--green)}
.stat .s-sub{font-size:11px;color:var(--muted);margin-top:3px}
.stat .s-bar{height:3px;border-radius:3px;margin-top:10px;background:#1a2340;overflow:hidden}
.stat .s-bar > div{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--gold),var(--amber))}

.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
.panel{
  background:linear-gradient(180deg,var(--panel),rgba(15,21,38,.55));
  border:1px solid var(--border);border-radius:12px;overflow:hidden;
}
.panel-head{
  display:flex;align-items:center;gap:10px;padding:12px 16px;
  border-bottom:1px solid var(--border-soft);
}
.panel-head .p-title{font-size:12.5px;font-weight:700;letter-spacing:.02em}
.panel-head .p-ic{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:12px;background:var(--panel-2);border:1px solid var(--border)}
.panel-head .p-meta{margin-left:auto;font-size:11px;color:var(--faint);font-family:var(--mono)}
.panel-body{padding:10px 14px 14px}

/* timeline */
.timeline{padding:6px 4px 2px}
.tl-item{display:grid;grid-template-columns:30px 1fr;gap:10px;position:relative;padding-bottom:2px}
.tl-item .tl-rail{display:flex;flex-direction:column;align-items:center}
.tl-item .tl-dot{width:14px;height:14px;border-radius:50%;border:2px solid var(--border);background:var(--panel-2);flex:none;position:relative;z-index:1;margin-top:14px}
.tl-item.phase-TRACE .tl-dot{border-color:var(--blue);box-shadow:0 0 0 3px rgba(97,166,250,.15)}
.tl-item.phase-observe .tl-dot{border-color:var(--green);box-shadow:0 0 0 3px rgba(61,220,151,.12)}
.tl-item.phase-propose .tl-dot{border-color:var(--amber);box-shadow:0 0 0 3px rgba(251,191,36,.15)}
.tl-item.phase-verify .tl-dot{border-color:var(--violet);box-shadow:0 0 0 3px rgba(167,139,250,.14)}
.tl-item.phase-settle .tl-dot{border-color:var(--gold);box-shadow:0 0 0 3px rgba(245,192,68,.16)}
.tl-item .tl-line{width:2px;flex:1;background:linear-gradient(180deg,var(--border),transparent);margin-top:2px}
.tl-item:last-child .tl-line{background:transparent}
.tl-card{
  border:1px solid var(--border-soft);border-radius:10px;background:var(--panel-2);
  padding:10px 12px;margin:4px 0 6px;cursor:pointer;transition:border-color .12s,background .12s;
}
.tl-card:hover{border-color:#2a3a5e;background:#15203a}
.tl-card.open{border-color:#2c3c5f}
.tl-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tl-name{font-weight:600;font-size:13px}
.tl-check{font-size:11px;color:var(--muted);font-family:var(--mono);background:var(--panel);padding:1px 7px;border-radius:5px;border:1px solid var(--border-soft)}
.tl-meta{margin-left:auto;font-size:11px;color:var(--faint);font-family:var(--mono);display:flex;align-items:center;gap:8px}
.usage-pill{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10.5px;color:var(--amber);background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);padding:1px 8px;border-radius:999px}
.cost-pill{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10.5px;color:var(--gold);background:rgba(245,192,68,.08);border:1px solid rgba(245,192,68,.22);padding:1px 8px;border-radius:999px}
.tl-summary{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}
.tl-body{display:none;margin-top:10px;border-top:1px dashed var(--border-soft);padding-top:10px}
.tl-card.open .tl-body{display:block}
.tl-body pre{
  background:#0a0f1e;border:1px solid var(--border-soft);border-radius:8px;padding:10px 12px;
  font-family:var(--mono);font-size:11px;line-height:1.55;color:#b9c6dd;overflow-x:auto;white-space:pre-wrap;word-break:break-word;
}
.chev{transition:transform .15s;color:var(--faint);font-size:10px}
.tl-card.open .chev{transform:rotate(90deg)}

/* tables */
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{
  text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
  color:var(--faint);padding:8px 10px;border-bottom:1px solid var(--border-soft);
}
td{padding:9px 10px;border-bottom:1px solid rgba(29,40,64,.5);vertical-align:middle}
tr:last-child td{border-bottom:none}
tbody tr{transition:background .1s}
tbody tr:hover{background:rgba(19,27,46,.6)}
.mono{font-family:var(--mono);font-size:11.5px}
.fp{color:var(--blue);font-family:var(--mono);font-size:11.5px}
.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
.cost-num{color:var(--gold);font-weight:700}
.ratio{display:flex;align-items:center;gap:8px}
.ratio .bar{flex:1;height:6px;border-radius:4px;background:#1a2340;overflow:hidden;display:flex;min-width:60px}
.ratio .bar i{display:block;height:100%}
.ratio .bar .in{background:linear-gradient(90deg,#2f6db5,#61a6fa)}
.ratio .bar .out{background:linear-gradient(90deg,#d99a2b,#f5c044)}
.ratio .lab{font-size:10.5px;color:var(--faint);font-family:var(--mono);white-space:nowrap}
.legend{display:flex;gap:14px;padding:8px 14px 12px;font-size:11px;color:var(--muted)}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:middle}
.legend .in{background:#61a6fa}.legend .out{background:#f5c044}

.empty{
  padding:40px 20px;text-align:center;color:var(--faint);
}
.empty .big{font-size:15px;font-weight:600;color:var(--muted);margin-bottom:6px}
.empty code{font-family:var(--mono);font-size:12px;background:var(--panel-2);padding:2px 8px;border-radius:6px;border:1px solid var(--border-soft)}
.loading{padding:60px;text-align:center;color:var(--faint)}
.spin{display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-4px;margin-right:8px}
@keyframes sp{to{transform:rotate(360deg)}}

/* search */
.search{position:relative;margin:0 0 14px}
.search input{
  width:100%;padding:9px 12px 9px 34px;border-radius:9px;border:1px solid var(--border);
  background:var(--panel);color:var(--text);font:inherit;font-size:12.5px;outline:none;transition:border-color .15s;
}
.search input:focus{border-color:#3a4d75}
.search input::placeholder{color:var(--faint)}
.search::before{content:"⌕";position:absolute;left:12px;top:50%;transform:translateY(-52%);color:var(--faint);font-size:14px}
.kv{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.kv .k{font-size:10px;color:var(--faint);font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em}
.kv .v{font-size:12px;font-family:var(--mono)}
.kv span{display:inline-flex;align-items:center;gap:6px;background:var(--panel);border:1px solid var(--border-soft);padding:3px 9px;border-radius:7px}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="logo">
      <div class="logo-mark">金</div>
      <div class="logo-name">kint<span>sugi</span></div>
    </div>
    <div class="topbar-sub">observability · ledger-joined traces</div>
    <div class="spacer"></div>
    <button class="btn" id="refreshBtn">⟳ &nbsp;Refresh</button>
  </div>

  <aside class="sidebar">
    <div class="sidebar-head">Runs <span class="run-count" id="runCount">0</span></div>
    <div class="run-list" id="runList"><div class="loading"><span class="spin"></span>loading traces…</div></div>
  </aside>

  <main class="main" id="main">
    <div class="loading" id="bootLoading"><span class="spin"></span>loading…</div>
  </main>
</div>

<script>
const TRACE_ID = '';
const PRICE = { in: 5 / 1e6, out: 25 / 1e6 };
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
const fmtCost = (c) => '$' + (c >= 1 ? c.toFixed(2) : c >= 0.001 ? c.toFixed(4) : c.toFixed(6));
const costOf = (u) => ((u && u.input) || 0) * PRICE.in + ((u && u.output) || 0) * PRICE.out;
const tsOf = (o) => new Date(o.startTime || 0).getTime();
const timeAgo = (t) => {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(t).toLocaleString();
};
const shortTime = (t) => t ? new Date(t).toLocaleTimeString([], { hour12: false }) : '';

let TRACES = {};   // traceId -> observations[]
let ORDER = [];    // sorted trace ids, newest first
let ACTIVE = null; // traceId

function badge(type) { return `<span class="badge b-${esc(type)}">${esc(type)}</span>`; }
function outcomeBadge(o) {
  const cls = 'bg-' + esc(o);
  const label = o === 'committed' ? 'committed' : o === 'quarantined' ? 'quarantined' : o === 'regressed' ? 'regressed' : o === 'reverted' ? 'reverted' : esc(o);
  return `<span class="badge ${cls}">${label}</span>`;
}
function providerBadge(p) { return p ? `<span class="badge bg-model">model</span>` : `<span class="badge bg-rules">rules</span>`; }

function traceStats(traceId) {
  const recs = TRACES[traceId] || [];
  const gens = recs.filter(o => (o.type || '').toUpperCase() === 'GENERATION');
  const settle = recs.find(o => o.name === 'settle');
  const verify = recs.find(o => o.name === 'verify');
  const times = recs.map(tsOf).filter(Boolean);
  const usage = gens.reduce((a, g) => ({
    input: a.input + ((g.usage && g.usage.input) || 0),
    output: a.output + ((g.usage && g.usage.output) || 0),
  }), { input: 0, output: 0 });
  const cost = gens.reduce((a, g) => a + costOf(g.usage), 0);
  const attempts = (settle && settle.input && settle.input.attempts) || [];
  const outcomes = {};
  for (const a of attempts) outcomes[a.outcome] = (outcomes[a.outcome] || 0) + 1;
  return {
    gens: gens.length, usage, cost, attempts, outcomes,
    duration: times.length ? Math.max(0, Math.max(...times) - Math.min(...times)) : 0,
    status: settle && settle.input ? (settle.input.status || 'settled') : 'traced',
    iterations: settle && settle.input ? (settle.input.iterations || 0) : 0,
    traceTime: times.length ? Math.min(...times) : Date.now(),
  };
}

function renderRuns() {
  const list = $('#runList');
  $('#runCount').textContent = ORDER.length;
  if (!ORDER.length) {
    list.innerHTML = `<div class="empty-side">No traces yet.<br>Run the loop with<br><code>LANGFUSE_HOST</code> pointed here.</div>`;
    return;
  }
  list.innerHTML = ORDER.map(id => {
    const st = traceStats(id);
    const cls = id === ACTIVE ? 'active' : '';
    const statusDot = st.status === 'converged' ? 'converged' : st.status === 'failed' ? 'failed' : 'settled';
    return `<div class="run-item ${cls}" data-tid="${esc(id)}">
      <div class="r-top"><span class="r-name">kintsugi</span><span class="r-time">${timeAgo(st.traceTime)}</span></div>
      <div class="r-stats">
        <span class="r-status"><span class="dot ${statusDot}"></span>${esc(st.status)}</span>
        <span>${st.attempts.length} attempt(s)</span>
        <span class="cost-num">${fmtCost(st.cost)}</span>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.run-item').forEach(el => {
    el.addEventListener('click', () => selectTrace(el.dataset.tid));
  });
}

function selectTrace(id) {
  ACTIVE = id;
  renderRuns();
  renderTrace();
  history.replaceState(null, '', '/?trace=' + id);
}

/* ---------- trace detail ---------- */
function renderTrace() {
  const main = $('#main');
  const recs = TRACES[ACTIVE] || [];
  const st = traceStats(ACTIVE);
  if (!recs.length) { main.innerHTML = `<div class="empty"><div class="big">Trace has no observations</div></div>`; return; }

  const settle = recs.find(o => o.name === 'settle');
  const attempts = (settle && settle.input && settle.input.attempts) || [];
  const gens = recs.filter(o => (o.type || '').toUpperCase() === 'GENERATION');
  const usage = st.usage;
  const totals = usage.input + usage.output;
  const inPct = totals ? Math.round(usage.input / totals * 100) : 0;

  const statCards = `
    <div class="stats">
      <div class="stat"><div class="s-label">Total cost</div>
        <div class="s-value gold">${fmtCost(st.cost)}</div>
        <div class="s-sub">${usage.input.toLocaleString()} in · ${usage.output.toLocaleString()} out</div>
        <div class="s-bar"><div style="width:${Math.min(100, st.cost > 0 ? 100 : 2)}%"></div></div>
      </div>
      <div class="stat"><div class="s-label">Tokens</div>
        <div class="s-value">${totals.toLocaleString()}</div>
        <div class="s-sub">${inPct}% input · ${100 - inPct}% output</div>
        <div class="s-bar"><div style="width:${inPct}%"></div></div>
      </div>
      <div class="stat"><div class="s-label">Model calls</div>
        <div class="s-value">${st.gens}</div>
        <div class="s-sub">${st.iterations} loop iteration(s)</div>
        <div class="s-bar"><div style="width:${Math.min(100, st.gens * 33)}%"></div></div>
      </div>
      <div class="stat"><div class="s-label">Attempts</div>
        <div class="s-value green">${attempts.length}</div>
        <div class="s-sub">${(Object.entries(st.outcomes).map(([k, v]) => k + ' ' + v).join(' · ')) || 'none'}</div>
        <div class="s-bar"><div style="width:${attempts.length ? 100 : 2}%"></div></div>
      </div>
    </div>`;

  main.innerHTML = `
    <div class="crumb">Trace <b>${ACTIVE.slice(0, 8)}</b> · ${timeAgo(st.traceTime)} · ${fmtCost(st.cost)}</div>
    <div class="main-head"><h1>${esc(settle && settle.input ? settle.input.status : 'run')}</h1>
      <span class="tid">${esc(ACTIVE)}</span></div>
    ${statCards}
    <div class="grid">
      <div class="panel">
        <div class="panel-head"><div class="p-ic">▸</div><div class="p-title">Run timeline</div>
          <div class="p-meta">${recs.length} observation(s)</div></div>
        <div class="panel-body timeline" id="timeline"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="p-ic">≡</div><div class="p-title">Attempts · ledger-joined</div>
          <div class="p-meta">settle span</div></div>
        <div class="panel-body">${attemptTable(attempts, gens)}</div>
      </div>
    </div>
    <div style="height:14px"></div>
    <div class="panel">
      <div class="panel-head"><div class="p-ic">#</div><div class="p-title">Per-finding cost</div>
        <div class="p-meta">generations joined by fingerprint</div></div>
      <div class="legend"><span><i class="in"></i>input tokens</span><span><i class="out"></i>output tokens</span></div>
      <div class="panel-body">${costTable(attempts, gens)}</div>
    </div>
    <div style="height:14px"></div>
    <div class="panel">
      <div class="panel-head"><div class="p-ic">⧉</div><div class="p-title">All observations</div>
        <div class="p-meta">click to expand payload</div></div>
      <div class="panel-body">
        <div class="search"><input id="obsSearch" placeholder="Filter observations…"></div>
        <div id="obsList">${obsList(recs, '')}</div>
      </div>
    </div>`;

  renderTimeline(recs);
  $('#obsSearch').addEventListener('input', (e) => {
    $('#obsList').innerHTML = obsList(recs, e.target.value.toLowerCase());
  });
}

function renderTimeline(recs) {
  const ordered = recs.slice().sort((a, b) => tsOf(a) - tsOf(b));
  const phase = (o) => {
    const t = (o.type || '').toUpperCase();
    const n = o.name || '';
    if (t === 'TRACE') return 'TRACE';
    if (n === 'settle') return 'settle';
    if (n === 'verify') return 'verify';
    if (n === 'propose' || t === 'GENERATION') return 'propose';
    if (n === 'observe') return 'observe';
    return 'span';
  };
  $('#timeline').innerHTML = ordered.map(o => {
    const p = phase(o);
    const n = o.name || o.type || '';
    const gen = (o.type || '').toUpperCase() === 'GENERATION';
    const u = o.usage || {};
    const pills = [];
    if (gen && (u.input || u.output)) pills.push(`<span class="usage-pill">${(u.input||0)} in · ${(u.output||0)} out</span><span class="cost-pill">${fmtCost(costOf(o.usage))}</span>`);
    if (n === 'verify' && o.input && o.input.outcome) pills.push(outcomeBadge(o.input.outcome));
    const check = o.input && o.input.check ? `<span class="tl-check">${esc(o.input.check)}</span>` : '';
    let summary = '';
    if (n === 'settle' && o.input) {
      summary = `<div class="tl-summary">${Object.entries(o.input).filter(([k]) => k !== 'attempts').map(([k, v]) =>
        `<span><span class="k">${esc(k)}</span><span class="v">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span></span>`).join('')}</div>`;
    }
    if (n === 'observe' && o.input && o.input.findings != null) {
      summary = `<div class="tl-summary"><span><span class="k">findings</span><span class="v">${o.input.findings}</span></span>
        <span><span class="k">duration</span><span class="v">${o.input.durationMs || 0}ms</span></span></div>`;
    }
    if (n === 'verify' && o.input && o.input.patch) {
      summary = `<div class="tl-summary"><span><span class="k">fingerprint</span><span class="v mono">${esc(o.input.fingerprint || '')}</span></span>
        <span><span class="k">outcome</span><span class="v">${esc(o.input.outcome || '')}</span></span>
        <span><span class="k">collateral</span><span class="v">${Array.isArray(o.input.collateral) ? o.input.collateral.length : 0} file(s)</span></span></div>`;
    }
    return `<div class="tl-item phase-${esc(p)}">
      <div class="tl-rail"><div class="tl-dot"></div><div class="tl-line"></div></div>
      <div class="tl-card">
        <div class="tl-row">
          ${badge(p === 'TRACE' ? 'TRACE' : p === 'observe' ? 'SPAN' : p === 'propose' ? 'GENERATION' : p === 'verify' ? 'SPAN' : p === 'settle' ? 'SPAN' : 'SPAN')}
          <span class="tl-name">${esc(n)}</span>${check}
          <span class="tl-meta">${shortTime(tsOf(o))}<span class="chev">▶</span></span>
        </div>
        ${pills.map(p => `<div class="tl-row" style="margin-top:6px">${p}</div>`).join('')}
        ${summary}
        <div class="tl-body"><pre>${esc(JSON.stringify(o, null, 2))}</pre></div>
      </div>
    </div>`;
  }).join('');
  $('#timeline').querySelectorAll('.tl-card').forEach(c => {
    c.addEventListener('click', () => c.classList.toggle('open'));
  });
}

function usageByFp(gens) {
  const m = new Map();
  for (const g of gens) {
    const fp = g.input && g.input.fingerprint;
    if (!fp) continue;
    const u = g.usage || {};
    const e = m.get(fp) || { input: 0, output: 0 };
    e.input += (u.input || 0); e.output += (u.output || 0);
    m.set(fp, e);
  }
  return m;
}

function attemptTable(attempts, gens) {
  if (!attempts.length) return `<div class="empty" style="padding:22px"><div class="big">No attempts recorded</div>This trace ran but repaired nothing.</div>`;
  const byFp = usageByFp(gens);
  const rows = attempts.map(a => {
    const t = byFp.get(a.fingerprint) || { input: 0, output: 0 };
    const patch = a.patch || {};
    return `<tr>
      <td><span class="fp">${esc(a.fingerprint)}</span></td>
      <td>${outcomeBadge(a.outcome)}</td>
      <td>${providerBadge(a.provider)}</td>
      <td class="mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(patch.rationale || '')}</td>
      <td class="num">${t.input.toLocaleString()}</td>
      <td class="num">${t.output.toLocaleString()}</td>
      <td class="num cost-num">${fmtCost(costOf(t))}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr><th>Fingerprint</th><th>Outcome</th><th>Provider</th><th>Patch rationale</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function costTable(attempts, gens) {
  if (!attempts.length) return `<div class="empty" style="padding:22px">No findings repaired in this run.</div>`;
  const byFp = usageByFp(gens);
  let rows = attempts.map(a => {
    const t = byFp.get(a.fingerprint) || { input: 0, output: 0 };
    const patch = a.patch || {};
    const cost = costOf(t);
    const tot = t.input + t.output;
    return { fp: a.fingerprint, finding: patch.rationale || a.check || '', outcome: a.outcome, cost, t, tot, provider: a.provider };
  });
  rows.sort((x, y) => y.cost - x.cost);
  const maxTot = Math.max(1, ...rows.map(r => r.tot));
  const total = rows.reduce((s, r) => ({ input: s.input + r.t.input, output: s.output + r.t.output }), { input: 0, output: 0 });
  const body = rows.map(r => {
    const inPct = r.tot ? Math.round(r.t.input / r.tot * 100) : 0;
    return `<tr>
      <td><span class="fp">${esc(r.fp)}</span></td>
      <td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.finding)}</td>
      <td>${outcomeBadge(r.outcome)}</td>
      <td>${providerBadge(r.provider)}</td>
      <td>
        <div class="ratio">
          <div class="bar"><i class="in" style="width:${inPct}%"></i><i class="out" style="width:${100 - inPct}%"></i></div>
          <span class="lab">${r.t.input.toLocaleString()}/${r.t.output.toLocaleString()}</span>
        </div>
      </td>
      <td class="num cost-num">${fmtCost(r.cost)}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr><th>Fingerprint</th><th>Finding</th><th>Outcome</th><th>Provider</th><th>Tokens (in/out)</th><th class="num">Cost</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr style="background:rgba(15,21,38,.7)"><td colspan="4" style="font-weight:700">TOTAL</td>
      <td class="mono">${total.input.toLocaleString()} / ${total.output.toLocaleString()}</td>
      <td class="num cost-num">${fmtCost(costOf(total))}</td></tr></tfoot>
  </table>`;
}

function obsList(recs, q) {
  const list = recs.filter(o => {
    if (!q) return true;
    const blob = (o.name || '') + ' ' + (o.type || '') + ' ' + JSON.stringify(o.input || {});
    return blob.toLowerCase().includes(q);
  });
  if (!list.length) return `<div class="empty" style="padding:20px">No observations match “${esc(q)}”.</div>`;
  return list.map(o => `<div class="tl-card">
    <div class="tl-row">
      ${badge(o.type || 'SPAN')}
      <span class="tl-name">${esc(o.name || '(unnamed)')}</span>
      ${o.input && o.input.check ? `<span class="tl-check">${esc(o.input.check)}</span>` : ''}
      <span class="tl-meta"><span class="chev">▶</span></span>
    </div>
    <div class="tl-body"><pre>${esc(JSON.stringify(o, null, 2))}</pre></div>
  </div>`).join('');
}

/* ---------- boot ---------- */
async function boot() {
  try {
    const res = await fetch('/api/public/v2/observations?limit=1000');
    const data = await res.json();
    TRACES = {};
    for (const o of (data.data || [])) (TRACES[o.traceId] = TRACES[o.traceId] || []).push(o);
    ORDER = Object.keys(TRACES).sort((a, b) => traceStats(b).traceTime - traceStats(a).traceTime);
    ACTIVE = TRACE_ID && TRACES[TRACE_ID] ? TRACE_ID : ORDER[0] || null;
    renderRuns();
    if (ACTIVE) renderTrace();
    else $('#main').innerHTML = `<div class="empty" style="padding:80px 20px">
      <div class="big">No traces yet</div>
      Run the loop with <code>LANGFUSE_HOST=http://127.0.0.1:8787</code> and the keys set — traces appear here live.<br><br>
      <button class="btn primary" onclick="location.reload()">⟳ &nbsp;Refresh</button></div>`;
  } catch (e) {
    $('#main').innerHTML = `<div class="empty" style="padding:80px"><div class="big">Could not reach the mock server</div><code>${esc(e.message)}</code></div>`;
  }
}
$('#refreshBtn').addEventListener('click', boot);
boot();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    print(f"[mock-langfuse] listening on http://127.0.0.1:{PORT}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
