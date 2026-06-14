import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Database } from "bun:sqlite";
import type { AuthEnv } from "../../auth/middleware.ts";
import type { ProxyRuntime } from "../../mcp/runtime.ts";
import type { Metrics, StatusSnapshot } from "../../metrics.ts";

/** Aggregate, anonymous gauges pulled live from the DB + supervisor. */
function gauges(db: Database, runtime: ProxyRuntime) {
  const connections = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM connections").get()!.n;
  const users = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n;
  return { activeChildren: runtime.supervisor.size, connections, users };
}

export function snapshot(db: Database, runtime: ProxyRuntime, metrics: Metrics): StatusSnapshot {
  return metrics.snapshot(gauges(db, runtime));
}

export function statusRouter(db: Database, runtime: ProxyRuntime, metrics: Metrics): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/json", (c) => c.json(snapshot(db, runtime, metrics)));

  // Server-Sent Events. A full snapshot is pushed every 5 minutes (the dashboard
  // is intentionally low-frequency); a tiny "ping" keepalive every 25s prevents
  // idle proxies/load-balancers from dropping the connection.
  const SNAPSHOT_EVERY = 12; // 12 × 25s = 5 min
  const MAX_STREAMS = 200;
  app.get("/stream", (c) => {
    // bound concurrent unauthenticated SSE streams (DoS / gauge-inflation guard)
    if (!metrics.tryAddDashboard(MAX_STREAMS)) return c.text("Too many viewers, try again shortly.", 503);
    return streamSSE(c, async (stream) => {
      try {
        let i = 0;
        while (!stream.aborted) {
          if (i % SNAPSHOT_EVERY === 0) {
            await stream.writeSSE({ data: JSON.stringify(snapshot(db, runtime, metrics)) });
          } else {
            await stream.writeSSE({ event: "ping", data: "1" });
          }
          i++;
          await stream.sleep(25_000);
        }
      } finally {
        metrics.removeDashboard();
      }
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Public landing / live status wall (no auth)

export function StatusLanding(props: { snap: StatusSnapshot }) {
  const s = props.snap;
  const initial = JSON.stringify(s);
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Azure DevOps MCP · live status</title>
        <link rel="icon" href="/assets/logo.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/assets/app.css" />
        <style>{CSS}</style>
      </head>
      <body class="status-body min-h-full text-text">
        <div class="mx-auto max-w-6xl px-6 py-10">
          <header class="mb-10 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <img src="/assets/logo.svg" alt="" class="h-9 w-9" />
              <div>
                <h1 class="text-lg font-semibold leading-tight">Azure DevOps MCP</h1>
                <p class="text-xs text-text-muted">multi-tenant gateway · live status</p>
              </div>
            </div>
            <div class="flex items-center gap-3 text-sm">
              <span class="live-dot" /> <span id="liveLabel" class="text-text-muted">updates every 5m</span>
              <a href="/login" class="rounded-md border border-base-600 px-3 py-1.5 hover:bg-base-800">Sign in</a>
              <a href="/register" class="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover">Get started</a>
            </div>
          </header>

          <section class="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Hero id="callsTotal" label="Tool calls (lifetime)" value={fmt(s.callsTotal)} />
            <Hero id="callsLastDay" label="Calls (24h)" value={fmt(s.callsLastDay)} accent />
            <Hero id="p95" label="p95 latency" value={`${s.latency.p95}ms`} />
            <Hero id="errorRate" label="Error rate" value={pctStr(s.errorRate)} />
          </section>

          <section class="mb-8 rounded-xl border border-base-700 bg-base-900/70 p-5">
            <div class="mb-3 flex items-center justify-between">
              <h2 class="text-sm font-semibold text-text-muted">Calls — last 24 hours</h2>
              <span class="text-xs text-text-muted">p50 <span id="p50">{s.latency.p50}</span>ms · last hour <span id="callsLastHour">{fmt(s.callsLastHour)}</span></span>
            </div>
            <div id="spark" class="spark">
              {s.spark.map((v) => <i style={`height:${barH(v, s.spark)}%`} />)}
            </div>
          </section>

          <section class="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div class="lg:col-span-2 rounded-xl border border-base-700 bg-base-900/70 p-5">
              <h2 class="mb-3 text-sm font-semibold text-text-muted">Live activity (anonymous)</h2>
              <ul id="feed" class="feed">
                {s.recent.map((e) => (
                  <li>
                    <span class={`dot ${e.ok ? "ok" : "err"}`} />
                    <span class="tool">{e.tool}</span>
                    <span class="ms">{e.ms}ms</span>
                    <span class="age">{e.ageS}s ago</span>
                  </li>
                ))}
              </ul>
              <p id="feedEmpty" class={s.recent.length ? "hidden" : "text-sm text-text-muted"}>No calls yet.</p>
            </div>
            <div class="space-y-4">
              <Gauge id="activeChildren" label="Active upstream servers" value={s.gauges.activeChildren} />
              <Gauge id="connections" label="Configured connections" value={s.gauges.connections} />
              <Gauge id="users" label="Accounts" value={s.gauges.users} />
              <Gauge id="dashboards" label="Watching this page" value={s.gauges.dashboards} />
              <div class="rounded-xl border border-base-700 bg-base-900/70 p-4 text-xs text-text-muted">
                Spawn p50 <span id="spawnP50">{s.spawns.p50ms}</span>ms · uptime <span id="uptime">{uptime(s.uptimeS)}</span>
              </div>
            </div>
          </section>

          <footer class="mt-10 text-center text-xs text-text-muted">
            Aggregate, anonymous metrics across all accounts. No organizations, identities, or credentials are shown.
          </footer>
        </div>

        <script
          // initial snapshot is server-rendered; the script keeps it live over SSE
          dangerouslySetInnerHTML={{ __html: `window.__INIT__=${initial};\n${SCRIPT}` }}
        />
      </body>
    </html>
  );
}

function Hero(props: { id: string; label: string; value: string; accent?: boolean }) {
  return (
    <div class={`hero rounded-xl border border-base-700 bg-base-900/70 p-5 ${props.accent ? "hero-accent" : ""}`}>
      <div id={props.id} class="text-3xl font-semibold tabular-nums md:text-4xl">{props.value}</div>
      <div class="mt-1 text-xs text-text-muted">{props.label}</div>
    </div>
  );
}

function Gauge(props: { id: string; label: string; value: number }) {
  return (
    <div class="flex items-center justify-between rounded-xl border border-base-700 bg-base-900/70 p-4">
      <span class="text-sm text-text-muted">{props.label}</span>
      <span id={props.id} class="text-xl font-semibold tabular-nums">{props.value}</span>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function pctStr(r: number): string {
  return `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`;
}
function barH(v: number, all: number[]): number {
  const max = Math.max(1, ...all);
  return Math.max(3, Math.round((v / max) * 100));
}
function uptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const CSS = `
.status-body{background:radial-gradient(1200px 600px at 50% -10%,rgba(0,120,212,.18),transparent),#0f0f10;}
.hero{transition:transform .2s,border-color .2s}
.hero:hover{transform:translateY(-2px)}
.hero-accent{box-shadow:0 0 0 1px rgba(0,120,212,.35),0 0 40px -12px rgba(0,120,212,.6)}
.live-dot{width:8px;height:8px;border-radius:9999px;background:#44cf6e;box-shadow:0 0 10px #44cf6e;animation:pulse 1.6s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.flash{animation:flash .6s ease-out}
@keyframes flash{0%{color:#2b88d8}100%{color:inherit}}
.spark{display:flex;align-items:flex-end;gap:2px;height:90px}
.spark i{flex:1;min-width:2px;background:linear-gradient(180deg,#2b88d8,#0078d4);border-radius:2px 2px 0 0;transition:height .4s ease}
.feed{display:flex;flex-direction:column;gap:.35rem;font-size:.8rem;max-height:340px;overflow:hidden}
.feed li{display:flex;align-items:center;gap:.6rem;padding:.3rem .1rem;border-bottom:1px solid #262626;animation:slidein .35s ease}
@keyframes slidein{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.feed .dot{width:7px;height:7px;border-radius:9999px;flex:none}
.feed .dot.ok{background:#44cf6e}.feed .dot.err{background:#e93147}
.feed .tool{font-family:ui-monospace,monospace;color:#dadada}
.feed .ms{color:#9e9e9e;margin-left:auto}
.feed .age{color:#6b6b6b;width:70px;text-align:right}
.hidden{display:none}
`;

const SCRIPT = `
(function(){
  var $=function(id){return document.getElementById(id)};
  function fmt(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':''+n}
  function set(id,v){var el=$(id);if(el&&el.textContent!==String(v)){el.textContent=v;el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash')}}
  function uptime(s){return s<60?s+'s':s<3600?Math.floor(s/60)+'m':s<86400?Math.floor(s/3600)+'h':Math.floor(s/86400)+'d'}
  function render(s){
    set('callsTotal',fmt(s.callsTotal));set('callsLastDay',fmt(s.callsLastDay));
    set('p95',s.latency.p95+'ms');set('errorRate',(s.errorRate*100).toFixed(s.errorRate<0.1?1:0)+'%');
    set('p50',s.latency.p50);set('callsLastHour',fmt(s.callsLastHour));set('spawnP50',s.spawns.p50ms);
    set('uptime',uptime(s.uptimeS));
    set('activeChildren',s.gauges.activeChildren);set('connections',s.gauges.connections);
    set('users',s.gauges.users);set('dashboards',s.gauges.dashboards);
    var max=Math.max(1,...s.spark),sp=$('spark');
    if(sp){var bars=sp.children;for(var i=0;i<bars.length&&i<s.spark.length;i++){bars[i].style.height=Math.max(3,Math.round(s.spark[i]/max*100))+'%'}}
    var feed=$('feed');
    if(feed){feed.innerHTML=s.recent.map(function(e){return '<li><span class="dot '+(e.ok?'ok':'err')+'"></span><span class="tool">'+e.tool.replace(/[<>&]/g,'')+'</span><span class="ms">'+e.ms+'ms</span><span class="age">'+e.ageS+'s ago</span></li>'}).join('');}
    var fe=$('feedEmpty');if(fe)fe.className=s.recent.length?'hidden':'text-sm text-text-muted';
  }
  if(window.__INIT__)render(window.__INIT__);
  try{
    var es=new EventSource('/status/stream');
    es.onmessage=function(ev){try{render(JSON.parse(ev.data))}catch(e){}};
    es.onerror=function(){var l=$('liveLabel');if(l){l.textContent='reconnecting…'}};
    es.onopen=function(){var l=$('liveLabel');if(l){l.textContent='live'}};
  }catch(e){}
})();
`;
