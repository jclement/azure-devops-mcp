import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { loadConfig, type Config } from "../src/config.ts";
import { openDatabase } from "../src/db/index.ts";
import { ChildSupervisor } from "../src/mcp/supervisor.ts";
import type { ProxyRuntime } from "../src/mcp/runtime.ts";
import type { SpawnFactory } from "../src/mcp/upstream.ts";
import { Metrics } from "../src/metrics.ts";
import { createApp } from "../src/app.tsx";

const FAKE = join(import.meta.dir, "fake-ado-mcp.ts");

/** A 32-byte master key fixed across a test run. */
export const TEST_MASTER_KEY = randomBytes(32).toString("base64");

export function testConfig(): Config {
  return loadConfig({
    PUBLIC_URL: "http://localhost:3000",
    MASTER_KEY: TEST_MASTER_KEY,
    DATA_DIR: "/tmp/ado-mcp-test",
  } as unknown as NodeJS.ProcessEnv);
}

/** SpawnFactory that launches the in-repo fake stdio server instead of npx. */
export function fakeSpawnFactory(): SpawnFactory {
  return (conn, pat) => ({
    command: "bun",
    args: [FAKE, conn.org],
    env: {
      ...(process.env as Record<string, string>),
      PERSONAL_ACCESS_TOKEN: Buffer.from(`${conn.email_label}:${pat}`).toString("base64"),
    },
  });
}

export interface TestApp {
  db: Database;
  config: Config;
  supervisor: ChildSupervisor;
  runtime: ProxyRuntime;
  metrics: Metrics;
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  close(): Promise<void>;
}

export async function bootTestApp(): Promise<TestApp> {
  const config = testConfig();
  const db = openDatabase(":memory:");
  const metrics = new Metrics();
  const supervisor = new ChildSupervisor(config.childKillGraceMs, (ms) => metrics.recordSpawn(ms));
  const runtime: ProxyRuntime = {
    supervisor,
    masterKey: config.masterKey,
    upstreamVersion: () => "test",
    spawnFactory: fakeSpawnFactory(),
  };
  const app = createApp({ config, db, runtime, metrics });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
  return {
    db,
    config,
    supervisor,
    runtime,
    metrics,
    server,
    baseUrl: `http://localhost:${server.port}`,
    close: async () => {
      await supervisor.shutdown();
      server.stop(true);
      db.close();
    },
  };
}

/** Insert a user directly (bypassing the WebAuthn ceremony) for test setup. */
export function createTestUser(db: Database, displayName: string): number {
  const res = db
    .query("INSERT INTO users (display_name, user_handle) VALUES (?, ?)")
    .run(displayName, randomBytes(16));
  return Number(res.lastInsertRowid);
}
