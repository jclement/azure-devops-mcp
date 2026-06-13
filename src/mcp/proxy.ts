import type { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Prompt,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthPrincipal } from "../auth/tokens.ts";
import {
  getConnectionBySlug,
  listConnections,
  openConnectionPat,
  touchConnection,
  type ConnectionRow,
} from "../connections/store.ts";
import type { ChildSupervisor } from "./supervisor.ts";
import type { SpawnFactory } from "./upstream.ts";
import { fail, ok } from "./respond.ts";
import { logger } from "../log.ts";

const log = logger("proxy");

/** Tool/prompt namespace separator: `<slug>__<upstreamName>`. */
const SEP = "__";

export const SERVER_INSTRUCTIONS = `Azure DevOps MCP (multi-tenant proxy).

This server fronts Microsoft's Azure DevOps MCP server, one child per connection
you have configured. Tools and prompts are namespaced by connection slug as
"<slug>__<tool>". Call list_connections first to see your connections (slug +
organization), then call the namespaced tools. You only ever see your own
connections — credentials never cross between users.`;

export interface ProxyDeps {
  db: Database;
  supervisor: ChildSupervisor;
  spawnFactory: SpawnFactory;
  masterKey: Buffer;
  upstreamVersion: () => string;
  principal: AuthPrincipal;
  /** Audit hook: connection slug (null for native tools), upstream tool name, args, result. */
  onCall?: (connection: string | null, tool: string, args: Record<string, unknown>, result: CallToolResult) => void;
}

function splitName(qualified: string): { slug: string; name: string } | null {
  const i = qualified.indexOf(SEP);
  if (i <= 0) return null;
  return { slug: qualified.slice(0, i), name: qualified.slice(i + SEP.length) };
}

/**
 * Build a per-user MCP server that proxies to the user's connections' upstream
 * children. The server is bound to exactly one user — `deps.principal.userId` —
 * and every connection lookup is scoped to that user, so there is no path from
 * this server to another user's connection or PAT.
 */
export function createProxyServer(deps: ProxyDeps): Server {
  const { db, supervisor, spawnFactory, masterKey, principal } = deps;
  const userId = principal.userId;

  const server = new Server(
    { name: "azure-devops-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  /** Resolve (and lazily spawn) the upstream client for one of this user's connections. */
  async function clientFor(conn: ConnectionRow): Promise<Client> {
    const pat = openConnectionPat(db, masterKey, userId, conn.id);
    if (pat == null) throw new Error(`Connection ${conn.slug} not found`);
    const spec = spawnFactory(conn, pat);
    const fingerprint = `${conn.updated_at}:${deps.upstreamVersion()}`;
    const client = await supervisor.acquire(conn.id, fingerprint, spec);
    touchConnection(db, conn.id);
    return client;
  }

  function capabilitiesOf(client: Client) {
    return client.getServerCapabilities() ?? {};
  }

  // --- tools ---------------------------------------------------------------

  const listConnectionsTool: Tool = {
    name: "list_connections",
    description:
      "List your configured Azure DevOps connections (slug and organization). Tools for each connection are exposed as '<slug>__<tool>'.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const conns = listConnections(db, userId);
    const tools: Tool[] = [listConnectionsTool];
    await Promise.all(
      conns.map(async (conn) => {
        try {
          const client = await clientFor(conn);
          if (!capabilitiesOf(client).tools) return;
          const { tools: upstream } = await client.listTools();
          for (const t of upstream) {
            tools.push({
              ...t,
              name: `${conn.slug}${SEP}${t.name}`,
              description: `[${conn.org}] ${t.description ?? ""}`.trim(),
            });
          }
        } catch (err) {
          // A broken connection (bad PAT, org typo) must not blank out the
          // whole list — surface it as a non-callable marker instead.
          log.warn(`listTools failed for connection ${conn.slug}: ${err instanceof Error ? err.message : err}`);
          tools.push({
            name: `${conn.slug}${SEP}connection_unavailable`,
            description: `[${conn.org}] This connection could not start (check its PAT/organization in the web UI).`,
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          });
        }
      }),
    );
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const fullName = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (fullName === "list_connections") {
      const result = ok(listConnections(db, userId).map((c) => ({ slug: c.slug, organization: c.org })));
      deps.onCall?.(null, fullName, args, result);
      return result;
    }

    const parsed = splitName(fullName);
    if (!parsed) {
      return fail("INVALID_TOOL", `Tool '${fullName}' is not namespaced. Use '<slug>__<tool>'; call list_connections.`);
    }
    // Tenant-isolation chokepoint: the slug is resolved ONLY among this user's
    // connections. A slug belonging to another user simply isn't found here.
    const conn = getConnectionBySlug(db, userId, parsed.slug);
    if (!conn) {
      const result = fail("UNKNOWN_CONNECTION", `No connection '${parsed.slug}'. Call list_connections to see yours.`);
      deps.onCall?.(parsed.slug, parsed.name, args, result);
      return result;
    }

    try {
      const client = await clientFor(conn);
      const result = (await client.callTool({ name: parsed.name, arguments: args })) as CallToolResult;
      deps.onCall?.(conn.slug, parsed.name, args, result);
      return result;
    } catch (err) {
      const result = fail("UPSTREAM_ERROR", err instanceof Error ? err.message : String(err));
      deps.onCall?.(conn.slug, parsed.name, args, result);
      return result;
    }
  });

  // --- prompts (forwarded if any child advertises them) --------------------

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const conns = listConnections(db, userId);
    const prompts: Prompt[] = [];
    await Promise.all(
      conns.map(async (conn) => {
        try {
          const client = await clientFor(conn);
          if (!capabilitiesOf(client).prompts) return;
          const { prompts: upstream } = await client.listPrompts();
          for (const p of upstream) prompts.push({ ...p, name: `${conn.slug}${SEP}${p.name}` });
        } catch {
          /* skip unavailable connection */
        }
      }),
    );
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const parsed = splitName(req.params.name);
    if (!parsed) throw new Error(`Prompt '${req.params.name}' is not namespaced as '<slug>__<prompt>'`);
    const conn = getConnectionBySlug(db, userId, parsed.slug);
    if (!conn) throw new Error(`No connection '${parsed.slug}'`);
    const client = await clientFor(conn);
    return client.getPrompt({ name: parsed.name, arguments: req.params.arguments });
  });

  return server;
}
