import { createHash } from "node:crypto";
import { join } from "node:path";

function int(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

export interface Config {
  port: number;
  /**
   * Configured public URL (PUBLIC_URL). When null the public origin is derived
   * from the reverse proxy's forwarded headers per request and the WebAuthn
   * rpID is pinned at first-passkey registration.
   */
  publicUrl: URL | null;
  /** True when running in proxy-derived mode (no PUBLIC_URL). */
  derived: boolean;
  rpId: string;
  origin: string;
  dataDir: string;
  dbPath: string;
  production: boolean;

  /**
   * 32-byte key (base64 or hex) used to encrypt Azure DevOps PATs at rest with
   * AES-256-GCM. REQUIRED in production. Losing it makes every stored PAT
   * unrecoverable; rotating it requires re-encrypting all rows. In dev, a
   * throwaway key is derived if unset (data won't survive a key change).
   */
  masterKey: Buffer;
  masterKeyEphemeral: boolean;

  /** Default pinned version of Microsoft's @azure-devops/mcp to spawn. */
  adoMcpVersion: string;
  /** When true, the updater adopts new upstream versions automatically. */
  adoMcpAutoUpdate: boolean;
  /** npm dist-tag to track for updates ("latest" or "next"). */
  adoMcpDistTag: string;
  /** How often to poll npm for a newer @azure-devops/mcp (ms). */
  updateCheckIntervalMs: number;

  /** Idle time before an unused upstream child process is reaped (ms). */
  childIdleMs: number;
  /** Grace period between SIGTERM and SIGKILL for upstream children (ms). */
  childKillGraceMs: number;

  /** Wipe all passkeys + sessions on boot (recovery from a lost authenticator). */
  authReset: boolean;
}

function loadMasterKey(env: NodeJS.ProcessEnv, production: boolean): { key: Buffer; ephemeral: boolean } {
  const raw = env.MASTER_KEY;
  if (!raw) {
    if (production) {
      throw new Error(
        "MASTER_KEY is required in production. Generate one with: openssl rand -base64 32 — and back it up; " +
          "losing it makes every stored PAT unrecoverable.",
      );
    }
    // Dev fallback: a fixed, well-known key derived from "DEVELOPMENT" so PATs
    // stored locally survive restarts. NEVER used in production (guarded above).
    return { key: createHash("sha256").update("DEVELOPMENT").digest(), ephemeral: true };
  }
  let key: Buffer;
  // accept base64 or hex
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`MASTER_KEY must decode to 32 bytes (got ${key.length}). Use: openssl rand -base64 32`);
  }
  return { key, ephemeral: false };
}

export function loadConfig(env = process.env): Config {
  const production = env.NODE_ENV === "production";
  const port = int("PORT", 3000);

  const rawUrl = env.PUBLIC_URL;
  let publicUrl: URL | null = null;
  if (rawUrl) {
    try {
      publicUrl = new URL(rawUrl);
    } catch {
      throw new Error(`PUBLIC_URL is not a valid URL: ${rawUrl}`);
    }
    const isLocalhost = publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1";
    if (publicUrl.protocol !== "https:" && !isLocalhost) {
      throw new Error("PUBLIC_URL must be https:// (passkeys require a secure context), except on localhost");
    }
    if (publicUrl.pathname !== "/") {
      throw new Error("PUBLIC_URL must not have a path component");
    }
  }

  const derived = publicUrl === null;
  const dataDir = env.DATA_DIR ?? "./data";
  const { key: masterKey, ephemeral } = loadMasterKey(env, production);

  return {
    port,
    publicUrl,
    derived,
    rpId: publicUrl?.hostname ?? "localhost",
    origin: publicUrl?.origin ?? `http://localhost:${port}`,
    dataDir,
    dbPath: env.DB_PATH ?? join(dataDir, "db", "app.db"),
    production,
    masterKey,
    masterKeyEphemeral: ephemeral,
    adoMcpVersion: env.ADO_MCP_VERSION ?? "latest",
    adoMcpAutoUpdate: bool("ADO_MCP_AUTO_UPDATE", false),
    adoMcpDistTag: env.ADO_MCP_DIST_TAG ?? "latest",
    updateCheckIntervalMs: int("UPDATE_CHECK_INTERVAL_MS", 6 * 3600_000),
    childIdleMs: int("CHILD_IDLE_MS", 10 * 60_000),
    childKillGraceMs: int("CHILD_KILL_GRACE_MS", 5000),
    authReset: bool("AUTH_RESET", false),
  };
}
