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

// Day chart: 48 buckets of 30 minutes = the last 24 hours.
const DAY_BUCKET_MS = 30 * 60_000;
const DAY_BUCKETS = 48;

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
  /** 30-min call buckets for the 24h chart + the bucket index of the last slot. */
  dayBuckets?: number[];
  dayIdx?: number;
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
  callsLastDay: number;
  /** 30-minute call counts for the last 24 hours (oldest→newest) */
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
  private dayBuckets: number[] = new Array(DAY_BUCKETS).fill(0);
  private dayIdx = Math.floor(Date.now() / DAY_BUCKET_MS);
  startedAt = Math.floor(Date.now() / 1000);
  /** Bumped on every recorded call; lets SSE skip pushing identical snapshots. */
  rev = 0;

  /** Advance the day buckets to the current 30-min slot, zeroing elapsed ones. */
  private rollDay(now: number) {
    const cur = Math.floor(now / DAY_BUCKET_MS);
    const diff = cur - this.dayIdx;
    if (diff <= 0) return;
    if (diff >= DAY_BUCKETS) {
      this.dayBuckets.fill(0);
    } else {
      for (let k = 0; k < diff; k++) {
        this.dayBuckets.shift();
        this.dayBuckets.push(0);
      }
    }
    this.dayIdx = cur;
  }

  recordCall(tool: string, ms: number, ok: boolean) {
    const now = Date.now();
    this.callsTotal++;
    if (!ok) this.errorsTotal++;
    this.perTool.set(tool, (this.perTool.get(tool) ?? 0) + 1);
    this.rollDay(now);
    this.dayBuckets[DAY_BUCKETS - 1]!++;

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

  /** Try to register a status-page viewer; false if the concurrency cap is hit. */
  tryAddDashboard(max = 200): boolean {
    if (this.dashboards >= max) return false;
    this.dashboards++;
    return true;
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
    if (Array.isArray(p.dayBuckets) && p.dayBuckets.length === DAY_BUCKETS && typeof p.dayIdx === "number") {
      this.dayBuckets = [...p.dayBuckets];
      this.dayIdx = p.dayIdx;
      this.rollDay(Date.now()); // discard any slots that aged out while down
    }
  }

  persisted(): PersistedMetrics {
    return {
      callsTotal: this.callsTotal,
      errorsTotal: this.errorsTotal,
      spawnsTotal: this.spawnsTotal,
      perTool: Object.fromEntries(this.perTool),
      startedAt: this.startedAt,
      dayBuckets: this.dayBuckets,
      dayIdx: this.dayIdx,
    };
  }

  snapshot(gauges: Omit<Gauges, "dashboards">): StatusSnapshot {
    const now = Date.now();
    const nowS = Math.floor(now / 1000);
    const lastMin = this.callTimes.filter((t) => t >= now - 60_000).length;

    // 30-minute buckets over the last 24 hours
    this.rollDay(now);
    const spark = [...this.dayBuckets];
    const callsLastDay = spark.reduce((a, b) => a + b, 0);

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
      callsLastDay,
      spark,
      latency: { p50: pct(sortedLat, 50), p95: pct(sortedLat, 95), count: this.latency.length },
      spawns: { total: this.spawnsTotal, p50ms: pct(sortedSpawn, 50) },
      topTools,
      gauges: { ...gauges, dashboards: this.dashboards },
      recent: this.recent.map((e) => ({ ageS: nowS - e.ts, tool: e.tool, ms: e.ms, ok: e.ok })),
    };
  }
}
