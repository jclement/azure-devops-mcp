import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { openDatabase, getSetting, setSetting } from "./db/index.ts";
import { createApp } from "./app.tsx";
import { Metrics } from "./metrics.ts";
import { sweepExpired } from "./auth/sessions.ts";
import { pruneAudit } from "./audit.ts";
import { ChildSupervisor } from "./mcp/supervisor.ts";
import { defaultSpawnFactory } from "./mcp/upstream.ts";
import type { ProxyRuntime } from "./mcp/runtime.ts";
import { adoptedVersion, checkForUpdate } from "./updater.ts";
import { logger } from "./log.ts";

const log = logger("server");

const config = loadConfig();

for (const dir of [config.dataDir, join(config.dataDir, "db")]) {
  mkdirSync(dir, { recursive: true });
}

const db = openDatabase(config.dbPath);

if (config.authReset) {
  db.exec("DELETE FROM passkey_credentials; DELETE FROM ui_sessions;");
  log.warn("AUTH_RESET=1: all passkeys and sessions wiped. Unset AUTH_RESET and restart after re-registering.");
}

if (config.masterKeyEphemeral) {
  log.warn(
    'MASTER_KEY is unset — using the built-in "DEVELOPMENT" key (dev only, NOT secure). Set MASTER_KEY (openssl rand -base64 32) in production.',
  );
}

// --- metrics (anonymous, for the public status page) ------------------------

const METRICS_KEY = "metrics_snapshot";
const metrics = new Metrics();
try {
  const raw = getSetting(db, METRICS_KEY);
  if (raw) metrics.load(JSON.parse(raw));
} catch (err) {
  log.warn(`could not load persisted metrics: ${err instanceof Error ? err.message : err}`);
}
const flushMetrics = () => setSetting(db, METRICS_KEY, JSON.stringify(metrics.persisted()));

// --- upstream child supervision ---------------------------------------------

const supervisor = new ChildSupervisor(config.childKillGraceMs, (ms) => metrics.recordSpawn(ms));
const runtime: ProxyRuntime = {
  supervisor,
  masterKey: config.masterKey,
  upstreamVersion: () => adoptedVersion(db, config),
  spawnFactory: defaultSpawnFactory({ version: () => adoptedVersion(db, config) }),
};

// --- periodic maintenance ----------------------------------------------------

setInterval(() => {
  sweepExpired(db);
  pruneAudit(db);
}, 3_600_000);
sweepExpired(db);

// reap idle upstream children at minute granularity so CHILD_IDLE_MS is accurate
setInterval(() => supervisor.reap(config.childIdleMs), 60_000);

// flush live metrics to disk so lifetime totals survive restarts
setInterval(flushMetrics, 30_000);

// npm update check (best-effort; logs and surfaces in the UI)
void checkForUpdate(db, config, supervisor);
setInterval(() => void checkForUpdate(db, config, supervisor), config.updateCheckIntervalMs);

// --- HTTP --------------------------------------------------------------------

const app = createApp({ config, db, runtime, metrics });

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 120, // SSE streams
});

log.info(
  `listening on http://localhost:${server.port} (public: ${config.publicUrl?.origin ?? "derived from proxy headers"})`,
);
log.info(`upstream @azure-devops/mcp version: ${adoptedVersion(db, config)}`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  await server.stop();
  await supervisor.shutdown(); // SIGTERM all Microsoft MCP children
  flushMetrics();
  db.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
