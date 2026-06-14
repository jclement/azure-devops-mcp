/**
 * In-memory metrics for the public status dashboard. Everything here is
 * AGGREGATE and ANONYMOUS — it deliberately holds no user ids, connection
 * slugs, organizations, arguments, or PAT material. Tool names are Microsoft's
 * generic upstream names. Lifetime counters are periodically flushed to the DB
 * (see server.ts) so totals survive restarts; rates/latency/recent are live-only.
 */

const RECENT_EVENTS = 30;
const LATENCY_SAMPLES = 500;
const CALL_TIME_WINDOW_MS = 3_600_000; // keep 1h of call timestamps for rates

export interface MetricEvent {
  /** seconds since epoch */
  ts: number;
  tool: string;
  ms: number;
  ok: boolean;
}

export interface PersistedMetrics {
  callsTotal: number;
  errorsTotal: number;
  spawnsTotal: number;
  perTool: Record<string, number>;
  startedAt: number;
}

export interface Gauges {
  activeChildren: number;
  connections: number;
  users: number;
  dashboards: number;
}

export interface StatusSnapshot {
  uptimeS: number;
  startedAt: number;
  callsTotal: number;
  errorsTotal: number;
  errorRate: number;
  callsLastMin: number;
  callsLastHour: number;
  /** per-second call counts for the last 60 seconds (oldest→newest) */
  spark: number[];
  latency: { p50: number; p95: number; count: number };
  spawns: { total: number; p50ms: number };
  topTools: { tool: string; count: number }[];
  gauges: Gauges;
  recent: { ageS: number; tool: string; ms: number; ok: boolean }[];
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[i]!);
}

export class Metrics {
  private callsTotal = 0;
  private errorsTotal = 0;
  private spawnsTotal = 0;
  private perTool = new Map<string, number>();
  private latency: number[] = [];
  private spawnMs: number[] = [];
  private callTimes: number[] = []; // ms timestamps, pruned to last hour
  private recent: MetricEvent[] = [];
  private dashboards = 0;
  startedAt = Math.floor(Date.now() / 1000);
  /** Bumped on every recorded call; lets SSE skip pushing identical snapshots. */
  rev = 0;

  recordCall(tool: string, ms: number, ok: boolean) {
    const now = Date.now();
    this.callsTotal++;
    if (!ok) this.errorsTotal++;
    this.perTool.set(tool, (this.perTool.get(tool) ?? 0) + 1);

    this.latency.push(ms);
    if (this.latency.length > LATENCY_SAMPLES) this.latency.shift();

    this.callTimes.push(now);
    const cutoff = now - CALL_TIME_WINDOW_MS;
    while (this.callTimes.length && this.callTimes[0]! < cutoff) this.callTimes.shift();

    this.recent.unshift({ ts: Math.floor(now / 1000), tool, ms: Math.round(ms), ok });
    if (this.recent.length > RECENT_EVENTS) this.recent.pop();
    this.rev++;
  }

  recordSpawn(ms: number) {
    this.spawnsTotal++;
    this.spawnMs.push(ms);
    if (this.spawnMs.length > LATENCY_SAMPLES) this.spawnMs.shift();
  }

  addDashboard() {
    this.dashboards++;
  }
  removeDashboard() {
    this.dashboards = Math.max(0, this.dashboards - 1);
  }
  get dashboardCount() {
    return this.dashboards;
  }

  load(p: Partial<PersistedMetrics> | null) {
    if (!p) return;
    this.callsTotal = p.callsTotal ?? 0;
    this.errorsTotal = p.errorsTotal ?? 0;
    this.spawnsTotal = p.spawnsTotal ?? 0;
    if (p.startedAt) this.startedAt = p.startedAt;
    if (p.perTool) for (const [k, v] of Object.entries(p.perTool)) this.perTool.set(k, v);
  }

  persisted(): PersistedMetrics {
    return {
      callsTotal: this.callsTotal,
      errorsTotal: this.errorsTotal,
      spawnsTotal: this.spawnsTotal,
      perTool: Object.fromEntries(this.perTool),
      startedAt: this.startedAt,
    };
  }

  snapshot(gauges: Omit<Gauges, "dashboards">): StatusSnapshot {
    const now = Date.now();
    const nowS = Math.floor(now / 1000);
    const lastMin = this.callTimes.filter((t) => t >= now - 60_000).length;

    // 60 one-second buckets for the live sparkline
    const spark = new Array(60).fill(0);
    for (const t of this.callTimes) {
      const age = Math.floor((now - t) / 1000);
      if (age >= 0 && age < 60) spark[59 - age]++;
    }

    const sortedLat = [...this.latency].sort((a, b) => a - b);
    const sortedSpawn = [...this.spawnMs].sort((a, b) => a - b);
    const topTools = [...this.perTool.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tool, count]) => ({ tool, count }));

    return {
      uptimeS: nowS - this.startedAt,
      startedAt: this.startedAt,
      callsTotal: this.callsTotal,
      errorsTotal: this.errorsTotal,
      errorRate: this.callsTotal ? this.errorsTotal / this.callsTotal : 0,
      callsLastMin: lastMin,
      callsLastHour: this.callTimes.length,
      spark,
      latency: { p50: pct(sortedLat, 50), p95: pct(sortedLat, 95), count: this.latency.length },
      spawns: { total: this.spawnsTotal, p50ms: pct(sortedSpawn, 50) },
      topTools,
      gauges: { ...gauges, dashboards: this.dashboards },
      recent: this.recent.map((e) => ({ ageS: nowS - e.ts, tool: e.tool, ms: e.ms, ok: e.ok })),
    };
  }
}
