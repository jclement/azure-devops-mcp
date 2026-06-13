import type { Database } from "bun:sqlite";
import type { AuthPrincipal } from "./auth/tokens.ts";

/** Where an audited event originated. Drives the UI source toggle. */
export type AuditSource = "agent" | "security" | "config";

export interface AuditEntry {
  id: number;
  ts: number;
  user_id: number | null;
  source: AuditSource;
  actor_kind: string;
  actor_name: string;
  connection: string | null;
  event: string;
  action: string | null;
  target: string | null;
  status: "ok" | "error";
  detail: string | null;
}

function insert(
  db: Database,
  e: {
    userId: number | null;
    source: AuditSource;
    actorKind: string;
    actorName: string;
    connection?: string | null;
    event: string;
    action?: string | null;
    target?: string | null;
    status?: "ok" | "error";
    detail?: string | null;
  },
) {
  db.query(
    "INSERT INTO audit_log (user_id, source, actor_kind, actor_name, connection, event, action, target, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    e.userId,
    e.source,
    e.actorKind,
    e.actorName,
    e.connection ?? null,
    e.event,
    e.action ?? null,
    e.target ?? null,
    e.status ?? "ok",
    e.detail ?? null,
  );
}

// --- Agent (MCP) calls -----------------------------------------------------

const TARGET_KEYS = ["project", "repository", "repositoryId", "id", "pullRequestId", "buildId", "query", "organization", "team", "wiql"];

/** Best-effort (action, target) from a passthrough tool's arguments. */
export function summarize(tool: string, args: Record<string, unknown>): { action: string | null; target: string | null } {
  let target: string | null = null;
  for (const k of TARGET_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v) {
      target = v.slice(0, 120);
      break;
    }
    if (typeof v === "number") {
      target = String(v);
      break;
    }
  }
  return { action: tool, target };
}

/**
 * Record an MCP tool call. `connection` is the connection slug the call was
 * routed to, and `tool` is the upstream (un-namespaced) tool name.
 */
export function recordMcpCall(
  db: Database,
  principal: AuthPrincipal,
  connection: string | null,
  tool: string,
  args: Record<string, unknown>,
  status: "ok" | "error",
  detail?: string,
) {
  const { action, target } = summarize(tool, args);
  insert(db, {
    userId: principal.userId,
    source: "agent",
    actorKind: principal.kind,
    actorName: principal.name,
    connection,
    event: tool,
    action,
    target,
    status,
    detail,
  });
}

// --- Owner (security/config) actions ---------------------------------------

function adminSourceFor(event: string): AuditSource {
  if (event.startsWith("connection.") || event.startsWith("upstream.")) return "config";
  return "security";
}

/** Record a user action from the management UI. */
export function recordAdmin(
  db: Database,
  userId: number | null,
  event: string,
  opts: { target?: string | null; status?: "ok" | "error"; detail?: string | null; actorName?: string } = {},
) {
  insert(db, {
    userId,
    source: adminSourceFor(event),
    actorKind: "user",
    actorName: opts.actorName ?? "user",
    event,
    action: null,
    target: opts.target ?? null,
    status: opts.status ?? "ok",
    detail: opts.detail ?? null,
  });
}

// --- Reading ---------------------------------------------------------------

export interface AuditQuery {
  userId: number;
  limit?: number;
  beforeId?: number;
  source?: AuditSource;
}

/** List audit rows for a single user (tenant-scoped). */
export function listAudit(db: Database, q: AuditQuery): AuditEntry[] {
  const limit = Math.min(q.limit ?? 100, 500);
  const where: string[] = ["user_id = ?"];
  const params: (string | number)[] = [q.userId];
  if (q.beforeId) {
    where.push("id < ?");
    params.push(q.beforeId);
  }
  if (q.source) {
    where.push("source = ?");
    params.push(q.source);
  }
  params.push(limit);
  return db
    .query<AuditEntry, (string | number)[]>(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...params);
}

const MAX_ROWS = 50_000;

export function pruneAudit(db: Database) {
  db.query("DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ?)").run(MAX_ROWS);
}
