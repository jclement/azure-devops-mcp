import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card, ago } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import type { ProxyRuntime } from "../../mcp/runtime.ts";
import {
  ConnectionError,
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  openConnectionPat,
  updateConnectionPat,
  type ConnectionRow,
} from "../../connections/store.ts";
import { recordAdmin } from "../../audit.ts";

function ConnectionTable(props: { connections: ConnectionRow[] }) {
  if (props.connections.length === 0) {
    return <p class="text-sm text-text-muted">No connections yet. Add an Azure DevOps organization and PAT above.</p>;
  }
  return (
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-base-700 text-left text-text-muted">
          <th class="py-2 pr-4 font-medium">Slug</th>
          <th class="py-2 pr-4 font-medium">Organization</th>
          <th class="py-2 pr-4 font-medium">PAT</th>
          <th class="py-2 pr-4 font-medium">Last used</th>
          <th class="py-2"></th>
        </tr>
      </thead>
      <tbody>
        {props.connections.map((conn) => (
          <tr class="border-b border-base-800">
            <td class="py-2 pr-4 font-mono">{conn.slug}</td>
            <td class="py-2 pr-4">{conn.org}</td>
            <td class="py-2 pr-4 font-mono text-text-muted">…{conn.pat_last4 ?? "????"}</td>
            <td class="py-2 pr-4 text-text-muted">{ago(conn.last_used_at)}</td>
            <td class="py-2 text-right whitespace-nowrap">
              <button
                hx-post={`/app/connections/${conn.id}/test`}
                hx-target={`#test-${conn.id}`}
                hx-swap="innerHTML"
                class="mr-3 text-sm text-accent hover:underline"
              >
                Test
              </button>
              <button
                hx-delete={`/app/connections/${conn.id}`}
                hx-confirm={`Delete connection '${conn.slug}'? Its stored PAT is erased and any running child is stopped.`}
                hx-target="#connection-list"
                class="text-sm text-danger hover:underline"
              >
                Delete
              </button>
              <div id={`test-${conn.id}`} class="mt-1 text-xs text-text-muted"></div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConnectionsPage(props: { connections: ConnectionRow[] }) {
  return (
    <Layout title="Connections" activeNav="/app/connections">
      <div class="space-y-6">
        <h1 class="text-xl font-semibold">Azure DevOps connections</h1>
        <Card title="Add connection">
          <form hx-post="/app/connections" hx-target="#connection-list" hx-swap="innerHTML" hx-on--after-request="if(event.detail.successful) this.reset()" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input name="org" required placeholder="Organization (e.g. contoso)" class="rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
            <input name="slug" placeholder="Slug (optional, defaults to org)" class="rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
            <input name="pat" required type="password" placeholder="Personal Access Token" class="rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none sm:col-span-2" />
            <input name="domains" placeholder="Toolset filter (optional, comma-separated)" class="rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none sm:col-span-2" />
            <div class="sm:col-span-2">
              <button type="submit" class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">Add connection</button>
            </div>
          </form>
          <p class="mt-3 text-xs text-text-muted">
            The PAT is encrypted at rest with the server master key and never shown again. Tools appear to agents as
            <span class="font-mono"> &lt;slug&gt;__&lt;tool&gt;</span>.
          </p>
        </Card>
        <Card title="Your connections">
          <div id="connection-list">
            <ConnectionTable connections={props.connections} />
          </div>
        </Card>
      </div>
    </Layout>
  );
}

export function connectionsRouter(db: Database, runtime: ProxyRuntime): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const key = runtime.masterKey;

  app.get("/", (c) => {
    const userId = c.var.session!.user_id;
    return c.html(<ConnectionsPage connections={listConnections(db, userId)} />);
  });

  app.post("/", async (c) => {
    const userId = c.var.session!.user_id;
    const body = await c.req.parseBody();
    try {
      const conn = createConnection(db, key, userId, {
        org: String(body.org ?? ""),
        slug: String(body.slug ?? ""),
        pat: String(body.pat ?? ""),
        domains: String(body.domains ?? "") || null,
      });
      recordAdmin(db, userId, "connection.create", { target: `${conn.slug} (${conn.org})` });
    } catch (err) {
      if (err instanceof ConnectionError) {
        return c.html(
          <>
            <p class="mb-3 text-sm text-danger">{err.message}</p>
            <ConnectionTable connections={listConnections(db, userId)} />
          </>,
        );
      }
      throw err;
    }
    return c.html(<ConnectionTable connections={listConnections(db, userId)} />);
  });

  app.post("/:id/test", async (c) => {
    const userId = c.var.session!.user_id;
    const id = c.req.param("id");
    const conn = getConnection(db, userId, id);
    if (!conn) return c.html(<span class="text-danger">Not found.</span>);
    try {
      const pat = openConnectionPat(db, key, userId, id)!;
      const client = await runtime.supervisor.acquire(
        conn.id,
        `${conn.updated_at}:${runtime.upstreamVersion()}`,
        runtime.spawnFactory(conn, pat),
      );
      const { tools } = await client.listTools();
      return c.html(<span class="text-success">OK — {tools.length} tools available.</span>);
    } catch (err) {
      return c.html(<span class="text-danger">Failed: {err instanceof Error ? err.message : String(err)}</span>);
    }
  });

  app.delete("/:id", async (c) => {
    const userId = c.var.session!.user_id;
    const id = c.req.param("id");
    const conn = getConnection(db, userId, id);
    if (conn && deleteConnection(db, userId, id)) {
      await runtime.supervisor.kill(id);
      recordAdmin(db, userId, "connection.delete", { target: `${conn.slug} (${conn.org})` });
    }
    return c.html(<ConnectionTable connections={listConnections(db, userId)} />);
  });

  app.post("/:id/pat", async (c) => {
    const userId = c.var.session!.user_id;
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    try {
      if (updateConnectionPat(db, key, userId, id, String(body.pat ?? ""))) {
        await runtime.supervisor.kill(id); // recycle child with the new PAT
        recordAdmin(db, userId, "connection.rotate_pat", { target: id });
      }
    } catch (err) {
      if (err instanceof ConnectionError) return c.html(<p class="text-sm text-danger">{err.message}</p>);
      throw err;
    }
    return c.html(<ConnectionTable connections={listConnections(db, userId)} />);
  });

  return app;
}
