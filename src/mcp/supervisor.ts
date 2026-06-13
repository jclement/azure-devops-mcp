import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SpawnSpec } from "./upstream.ts";
import { logger } from "../log.ts";

const log = logger("supervisor");

interface Entry {
  client: Client;
  transport: StdioClientTransport;
  fingerprint: string;
  lastUsed: number;
}

/**
 * Owns the pool of Microsoft `@azure-devops/mcp` child processes — one per
 * connection. Children are keyed strictly by connection id (which a caller can
 * only obtain by querying rows scoped to the authenticated user), so a child
 * holding one user's PAT is never reachable from another user's request.
 *
 * Children are spawned lazily on first use, kept warm, recycled when the
 * connection's fingerprint changes (PAT rotation / version bump), and reaped
 * when idle.
 */
export class ChildSupervisor {
  private entries = new Map<string, Entry>();
  private starting = new Map<string, Promise<Client>>();
  private shuttingDown = false;

  constructor(private killGraceMs: number) {}

  /** Get (or spawn) the live MCP client for a connection. */
  async acquire(connId: string, fingerprint: string, spec: SpawnSpec): Promise<Client> {
    if (this.shuttingDown) throw new Error("Server is shutting down");

    const existing = this.entries.get(connId);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        existing.lastUsed = Date.now();
        return existing.client;
      }
      // PAT/version/config changed — drop the stale child before respawning.
      await this.kill(connId);
    }

    const inFlight = this.starting.get(connId);
    if (inFlight) return inFlight;

    const startPromise = this.spawn(connId, fingerprint, spec).finally(() => this.starting.delete(connId));
    this.starting.set(connId, startPromise);
    return startPromise;
  }

  private async spawn(connId: string, fingerprint: string, spec: SpawnSpec): Promise<Client> {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      stderr: "pipe",
    });
    const client = new Client({ name: "azure-devops-mcp-proxy", version: "0.1.0" });

    transport.onclose = () => {
      const cur = this.entries.get(connId);
      if (cur && cur.transport === transport) this.entries.delete(connId);
    };
    transport.onerror = (err) => log.warn(`child ${connId} transport error: ${err.message}`);

    await client.connect(transport);
    // surface child stderr at debug level for troubleshooting
    transport.stderr?.on("data", (b: Buffer) => log.debug(`child ${connId} stderr: ${b.toString().trimEnd()}`));

    this.entries.set(connId, { client, transport, fingerprint, lastUsed: Date.now() });
    log.info(`spawned upstream child for connection ${connId}`);
    return client;
  }

  /** Terminate a connection's child (e.g. on delete or PAT rotation). */
  async kill(connId: string) {
    const entry = this.entries.get(connId);
    if (!entry) return;
    this.entries.delete(connId);
    try {
      await entry.client.close();
    } catch {}
    try {
      await entry.transport.close();
    } catch {}
    log.info(`stopped upstream child for connection ${connId}`);
  }

  /** Reap children idle longer than `idleMs`. Called periodically. */
  reap(idleMs: number) {
    const cutoff = Date.now() - idleMs;
    for (const [connId, entry] of this.entries) {
      if (entry.lastUsed < cutoff) void this.kill(connId);
    }
  }

  /** Stop all children without shutting the supervisor down (e.g. after a version bump). */
  async recycleAll() {
    await Promise.all([...this.entries.keys()].map((id) => this.kill(id)));
  }

  async shutdown() {
    this.shuttingDown = true;
    await Promise.all([...this.entries.keys()].map((id) => this.kill(id)));
  }

  get size() {
    return this.entries.size;
  }
}
