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
  --bg:#f5f6f8; --panel:#ffffff; --panel-2:#fafbfc;
  --border:#e5e8ee; --border-soft:#eef0f4;
  --text:#0f172a; --muted:#576073; --faint:#9aa3b2;
  --gold:#b45309; --gold-bright:#f59e0b; --gold-soft:#fdf4e3;
  --green:#16794c; --green-bg:#e8f6ef;
  --red:#d92d20; --red-bg:#fdeceb;
  --violet:#7c3aed; --violet-bg:#f3eefd;
  --blue:#2563eb; --blue-bg:#eaf1fe;
  --amber:#b45309; --amber-bg:#fdf3e2;
  --cyan:#0e7490; --cyan-bg:#e6f5f9;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  --shadow-sm:0 1px 2px rgba(16,24,40,.04);
  --shadow-md:0 1px 2px rgba(16,24,40,.05),0 4px 14px -3px rgba(16,24,40,.07);
  --shadow-lg:0 2px 4px rgba(16,24,40,.05),0 14px 28px -10px rgba(16,24,40,.14);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:var(--bg); color:var(--text); font-family:var(--sans); font-size:14px;
  -webkit-font-smoothing:antialiased; overflow:hidden;
  font-feature-settings:"cv02","cv03","cv04","cv11";
}
body::before{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:0;
  background:
    radial-gradient(560px 260px at 10% -6%, rgba(245,158,11,.08), transparent 60%),
    radial-gradient(640px 300px at 96% -8%, rgba(37,99,235,.06), transparent 60%);
}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#d4d9e1;border-radius:6px;border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:#b9c1cd}
::-webkit-scrollbar-track{background:transparent}

/* ---------- layout ---------- */
.app{display:grid;grid-template-columns:286px 1fr;height:100vh;position:relative;z-index:1}
.topbar{
  grid-column:1/3; display:flex; align-items:center; gap:16px;
  padding:0 20px; height:58px; position:relative; z-index:2;
  background:rgba(255,255,255,.82); backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border);
}
.logo{display:flex;align-items:center;gap:11px;user-select:none}
.logo-mark{
  width:28px;height:28px;border-radius:9px;flex:none;
  background:linear-gradient(135deg,#fbbf24,#d97706);
  display:grid;place-items:center;color:#431407;font-weight:800;font-size:14px;
  box-shadow:0 1px 2px rgba(217,119,6,.35), inset 0 1px 0 rgba(255,255,255,.35);
}
.logo-name{font-weight:750;letter-spacing:-.01em;font-size:15.5px;color:var(--text)}
.logo-name span{color:#b45309}
.topbar-sub{color:var(--faint);font-size:12px;font-weight:550;letter-spacing:.01em}
.spacer{flex:1}
.live{
  display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:650;
  color:var(--muted);background:var(--panel);border:1px solid var(--border);
  padding:5px 11px;border-radius:999px;letter-spacing:.02em;
}
.live .pulse{width:7px;height:7px;border-radius:50%;background:#22c55e;position:relative}
.live .pulse::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:1.5px solid rgba(34,197,94,.5);animation:ring 1.8s ease-out infinite}
@keyframes ring{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.4);opacity:0}}
.btn{
  display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:9px;
  border:1px solid var(--border);background:var(--panel);color:var(--text);
  font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:all .15s;
  box-shadow:var(--shadow-sm);
}
.btn:hover{border-color:#cdd3dd;box-shadow:var(--shadow-md);transform:translateY(-1px)}
.btn:active{transform:translateY(0);box-shadow:var(--shadow-sm)}
.btn:focus-visible{outline:2px solid rgba(37,99,235,.5);outline-offset:2px}
.btn.primary{
  background:linear-gradient(135deg,#fbbf24,#d97706);color:#431407;border-color:rgba(217,119,6,.35);
  box-shadow:0 2px 8px -2px rgba(217,119,6,.45);
}
.btn.primary:hover{filter:brightness(1.05)}
.badge{
  display:inline-flex;align-items:center;gap:5px;padding:2.5px 9px;border-radius:999px;
  font-size:10px;font-weight:750;letter-spacing:.07em;text-transform:uppercase;white-space:nowrap;
  border:1px solid transparent;
}
.b-TRACE{background:var(--blue-bg);color:var(--blue);border-color:#d7e5fd}
.b-SPAN{background:var(--green-bg);color:var(--green);border-color:#d3efe2}
.b-GENERATION{background:var(--amber-bg);color:var(--amber);border-color:#f8e6c6}
.b-EVENT{background:var(--cyan-bg);color:var(--cyan);border-color:#cfebf1}
.bg-committed{background:var(--green-bg);color:var(--green);border-color:#cdeede}
.bg-reverted,.bg-regressed{background:var(--red-bg);color:var(--red);border-color:#f8d6d4}
.bg-quarantined,.bg-escalated{background:var(--violet-bg);color:var(--violet);border-color:#e4d9fb}
.bg-ineffective{background:var(--amber-bg);color:var(--amber);border-color:#f8e6c6}
.bg-rules{background:#f0f2f5;color:#6b7280;border-color:#e2e5ea}
.bg-model{background:var(--blue-bg);color:var(--blue);border-color:#d7e5fd}

/* ---------- sidebar ---------- */
.sidebar{
  border-right:1px solid var(--border);background:rgba(255,255,255,.66);
  display:flex;flex-direction:column;min-height:0;
}
.sidebar-head{padding:18px 18px 10px;font-size:10.5px;font-weight:750;letter-spacing:.13em;color:var(--faint);text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}
.run-count{color:#b45309;font-weight:800;background:var(--gold-soft);padding:1px 8px;border-radius:999px;font-size:10.5px}
.run-list{flex:1;overflow-y:auto;padding:0 12px 18px}
.run-item{
  padding:11px 12px;border-radius:11px;border:1px solid transparent;cursor:pointer;
  margin-bottom:6px;transition:all .14s;position:relative;
}
.run-item:hover{background:#ffffff;border-color:var(--border);box-shadow:var(--shadow-sm)}
.run-item.active{background:#ffffff;border-color:#e9ddc3;box-shadow:var(--shadow-md)}
.run-item.active::before{content:"";position:absolute;left:-12px;top:11px;bottom:11px;width:3px;border-radius:3px;background:linear-gradient(180deg,#fbbf24,#d97706)}
.run-item .r-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.run-item .r-name{font-weight:650;font-size:13px;color:var(--text)}
.run-item .r-time{font-size:11px;color:var(--faint);font-family:var(--mono)}
.run-item .r-stats{display:flex;gap:10px;margin-top:7px;align-items:center;font-size:11px;color:var(--muted)}
.run-item .r-status{display:inline-flex;align-items:center;gap:5px;font-weight:600}
.dot{width:7px;height:7px;border-radius:50%;background:#c9cfd8;flex:none}
.dot.converged{background:#22c55e}
.dot.failed,.dot.regressed{background:#ef4444}
.dot.quarantined{background:#a78bfa}
.empty-side{padding:22px 18px;color:var(--faint);font-size:12.5px;line-height:1.65}

/* ---------- main ---------- */
.main{overflow-y:auto;min-height:0;padding:22px 26px 70px}
.main-head{display:flex;align-items:baseline;gap:12px;margin-bottom:2px}
.main-head h1{font-size:20px;font-weight:750;letter-spacing:-.02em}
.main-head .tid{font-family:var(--mono);font-size:12px;color:var(--faint)}
.main-head .tid::before{content:"· ";color:#b45309}
.crumb{color:var(--faint);font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px;display:flex;align-items:center;gap:8px}
.crumb b{color:#b45309;font-weight:750}
.crumb .sep{color:var(--border)}

.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:18px 0 20px}
.stat{
  background:var(--panel);border:1px solid var(--border);border-radius:14px;
  padding:15px 17px 13px;box-shadow:var(--shadow-sm);transition:all .18s;
  animation:fadeUp .4s ease both;
}
.stat:nth-child(2){animation-delay:.05s}.stat:nth-child(3){animation-delay:.1s}.stat:nth-child(4){animation-delay:.15s}
.stat:hover{box-shadow:var(--shadow-md);transform:translateY(-1px)}
.stat .s-label{font-size:10px;font-weight:750;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
.stat .s-value{font-size:23px;font-weight:800;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums;color:var(--text)}
.stat .s-value.gold{color:#b45309}
.stat .s-value.green{color:var(--green)}
.stat .s-sub{font-size:11.5px;color:var(--muted);margin-top:3px;font-variant-numeric:tabular-nums}
.stat .s-bar{height:4px;border-radius:4px;margin-top:11px;background:#eef0f4;overflow:hidden}
.stat .s-bar > div{height:100%;border-radius:4px;background:linear-gradient(90deg,#fbbf24,#d97706);transition:width .5s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}

.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
.panel{
  background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden;
  box-shadow:var(--shadow-sm);animation:fadeUp .4s ease .1s both;
}
.panel-head{display:flex;align-items:center;gap:10px;padding:13px 17px;border-bottom:1px solid var(--border-soft)}
.panel-head .p-title{font-size:12.5px;font-weight:700;letter-spacing:.01em}
.panel-head .p-ic{
  width:22px;height:22px;border-radius:7px;display:grid;place-items:center;font-size:11px;
  background:var(--panel-2);border:1px solid var(--border);color:var(--muted);
}
.panel-head .p-meta{margin-left:auto;font-size:11px;color:var(--faint);font-family:var(--mono)}
.panel-body{padding:12px 16px 16px}

/* timeline */
.timeline{padding:6px 2px 2px}
.tl-item{display:grid;grid-template-columns:28px 1fr;gap:10px;position:relative;padding-bottom:1px}
.tl-item .tl-rail{display:flex;flex-direction:column;align-items:center}
.tl-item .tl-dot{
  width:13px;height:13px;border-radius:50%;border:2px solid #ffffff;flex:none;position:relative;z-index:1;
  margin-top:15px;box-shadow:0 0 0 1.5px var(--border), var(--shadow-sm);
}
.tl-item.phase-TRACE .tl-dot{background:#3b82f6;box-shadow:0 0 0 3px var(--blue-bg)}
.tl-item.phase-observe .tl-dot{background:#10b981;box-shadow:0 0 0 3px var(--green-bg)}
.tl-item.phase-propose .tl-dot{background:#f59e0b;box-shadow:0 0 0 3px var(--amber-bg)}
.tl-item.phase-verify .tl-dot{background:#8b5cf6;box-shadow:0 0 0 3px var(--violet-bg)}
.tl-item.phase-settle .tl-dot{background:#d97706;box-shadow:0 0 0 3px var(--gold-soft)}
.tl-item .tl-line{width:2px;flex:1;background:linear-gradient(180deg,#e5e8ee,#f0f2f6);margin-top:2px}
.tl-item:last-child .tl-line{background:transparent}
.tl-card{
  border:1px solid var(--border-soft);border-radius:11px;background:var(--panel-2);
  padding:10px 13px;margin:4px 0 7px;cursor:pointer;transition:all .15s;
}
.tl-card:hover{border-color:#d8dde6;background:#ffffff;box-shadow:var(--shadow-sm)}
.tl-card.open{border-color:#e5d5b4;background:#ffffff;box-shadow:var(--shadow-md)}
.tl-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tl-name{font-weight:650;font-size:13px;color:var(--text)}
.tl-check{
  font-size:11px;color:var(--muted);font-family:var(--mono);background:#ffffff;
  padding:1.5px 8px;border-radius:6px;border:1px solid var(--border);
}
.tl-meta{margin-left:auto;font-size:11px;color:var(--faint);font-family:var(--mono);display:flex;align-items:center;gap:8px}
.usage-pill{
  display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10.5px;
  color:#92400e;background:var(--amber-bg);border:1px solid #f6e3c4;padding:1.5px 9px;border-radius:999px;font-weight:600;
}
.cost-pill{
  display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10.5px;
  color:#b45309;background:var(--gold-soft);border:1px solid #f3dfb8;padding:1.5px 9px;border-radius:999px;font-weight:700;
}
.tl-summary{margin-top:9px;display:flex;gap:7px;flex-wrap:wrap}
.tl-body{display:none;margin-top:10px;border-top:1px dashed var(--border);padding-top:10px}
.tl-card.open .tl-body{display:block}
.tl-body pre{
  background:#f8f9fb;border:1px solid var(--border-soft);border-radius:9px;padding:11px 13px;
  font-family:var(--mono);font-size:11px;line-height:1.6;color:#334155;overflow-x:auto;white-space:pre-wrap;word-break:break-word;
}
.chev{transition:transform .18s;color:var(--faint);font-size:9px;display:inline-block}
.tl-card.open .chev{transform:rotate(90deg)}

/* tables */
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{
  text-align:left;font-size:10px;font-weight:750;letter-spacing:.1em;text-transform:uppercase;
  color:var(--faint);padding:9px 10px;border-bottom:1px solid var(--border);
  white-space:nowrap;
}
td{padding:10px;border-bottom:1px solid var(--border-soft);vertical-align:middle}
tr:last-child td{border-bottom:none}
tbody tr{transition:background .1s}
tbody tr:hover{background:#f8f9fb}
.mono{font-family:var(--mono);font-size:11.5px}
.fp{color:#2563eb;font-family:var(--mono);font-size:11.5px;font-weight:600}
.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
.cost-num{color:#b45309;font-weight:750}
.ratio{display:flex;align-items:center;gap:9px}
.ratio .bar{flex:1;height:7px;border-radius:4px;background:#eef0f4;overflow:hidden;display:flex;min-width:64px}
.ratio .bar i{display:block;height:100%}
.ratio .bar .in{background:linear-gradient(90deg,#60a5fa,#3b82f6)}
.ratio .bar .out{background:linear-gradient(90deg,#fbbf24,#d97706)}
.ratio .lab{font-size:10.5px;color:var(--faint);font-family:var(--mono);white-space:nowrap;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:16px;padding:9px 16px 12px;font-size:11px;color:var(--muted)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.legend .in{background:#3b82f6}.legend .out{background:#f59e0b}

.empty{padding:44px 20px;text-align:center;color:var(--faint)}
.empty .big{font-size:15px;font-weight:650;color:var(--muted);margin-bottom:7px}
.empty code{font-family:var(--mono);font-size:12px;background:var(--panel-2);padding:2.5px 9px;border-radius:7px;border:1px solid var(--border)}
.loading{padding:60px;text-align:center;color:var(--faint)}
.spin{
  display:inline-block;width:17px;height:17px;border:2px solid var(--border);
  border-top-color:#d97706;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-4px;margin-right:9px;
}
@keyframes sp{to{transform:rotate(360deg)}}

/* search */
.search{position:relative;margin:0 0 14px}
.search input{
  width:100%;padding:9.5px 13px 9.5px 36px;border-radius:10px;border:1px solid var(--border);
  background:var(--panel-2);color:var(--text);font:inherit;font-size:13px;outline:none;transition:all .15s;
}
.search input:focus{border-color:#b9c6dd;background:#ffffff;box-shadow:0 0 0 3.5px rgba(37,99,235,.1)}
.search input::placeholder{color:var(--faint)}
.search::before{
  content:"⌕";position:absolute;left:13px;top:50%;transform:translateY(-54%);color:var(--faint);font-size:15px;
}
.kv{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}
.kv .k{font-size:10px;color:var(--faint);font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em}
.kv .v{font-size:12px;font-family:var(--mono)}
.kv span{display:inline-flex;align-items:center;gap:7px;background:#ffffff;border:1px solid var(--border);padding:3.5px 10px;border-radius:8px}
@media (max-width:1180px){
  .grid{grid-template-columns:1fr}
}
@media (max-width:900px){
  .app{grid-template-columns:1fr;grid-template-rows:auto 1fr}
  .sidebar{border-right:none;border-bottom:1px solid var(--border);max-height:150px}
  .sidebar-head{display:none}
  .run-list{display:flex;gap:8px;overflow-x:auto;padding:10px 14px}
  .run-item{flex:0 0 200px;margin-bottom:0}
  .run-item.active::before{top:auto;bottom:-10px;left:12px;right:12px;width:auto;height:3px}
  .stats{grid-template-columns:repeat(2,1fr)}
}
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
    <div class="live"><span class="pulse"></span>local · mock langfuse</div>
    <button class="btn primary" id="refreshBtn">⟳ &nbsp;Refresh</button>
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
    <div class="crumb">Trace <b>${ACTIVE.slice(0, 8)}</b> <span class="sep">/</span> ${timeAgo(st.traceTime)} <span class="sep">/</span> ${fmtCost(st.cost)}</div>
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
    <div style="height:16px"></div>
    <div class="panel">
      <div class="panel-head"><div class="p-ic">#</div><div class="p-title">Per-finding cost</div>
        <div class="p-meta">generations joined by fingerprint</div></div>
      <div class="legend"><span><i class="in"></i>input tokens</span><span><i class="out"></i>output tokens</span></div>
      <div class="panel-body">${costTable(attempts, gens)}</div>
    </div>
    <div style="height:16px"></div>
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
  $('#timeline').innerHTML = ordered.map((o, i) => {
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
      <div class="tl-card" style="animation:fadeUp .35s ease ${Math.min(i * .04, .5)}s both">
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
  if (!attempts.length) return `<div class="empty" style="padding:24px"><div class="big">No attempts recorded</div>This trace ran but repaired nothing.</div>`;
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
  if (!attempts.length) return `<div class="empty" style="padding:24px">No findings repaired in this run.</div>`;
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
    <tfoot><tr style="background:var(--panel-2)"><td colspan="4" style="font-weight:750">TOTAL</td>
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
  if (!list.length) return `<div class="empty" style="padding:22px">No observations match “${esc(q)}”.</div>`;
  return list.map(o => `<div class="tl-card" style="animation:fadeUp .3s ease both">
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
