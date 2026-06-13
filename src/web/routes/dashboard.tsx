import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Config } from "../../config.ts";
import { Layout, Card, ago } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { listConnections } from "../../connections/store.ts";
import { listApiTokens } from "../../auth/tokens.ts";
import { listUserOAuthClients } from "../../oauth/router.ts";
import { getUser } from "../../auth/webauthn.ts";
import { adoptVersion, upstreamStatus } from "../../updater.ts";
import type { ProxyRuntime } from "../../mcp/runtime.ts";
import { recordAdmin } from "../../audit.ts";

function Stat(props: { label: string; value: string | number; href: string }) {
  return (
    <a href={props.href} class="rounded-lg border border-base-700 bg-base-900 p-5 hover:border-base-600">
      <div class="text-2xl font-semibold">{props.value}</div>
      <div class="text-sm text-text-muted">{props.label}</div>
    </a>
  );
}

export function dashboardRouter(db: Database, config: Config, runtime: ProxyRuntime): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => {
    const userId = c.var.session!.user_id;
    const user = getUser(db, userId);
    const conns = listConnections(db, userId);
    const tokens = listApiTokens(db, userId).filter((t) => !t.revoked_at);
    const clients = listUserOAuthClients(db, userId);
    const up = upstreamStatus(db, config);
    return c.html(
      <Layout title="Dashboard" activeNav="/app" userName={user?.display_name}>
        <div class="space-y-6">
          <h1 class="text-xl font-semibold">Welcome{user ? `, ${user.display_name}` : ""}</h1>
          {up.updateAvailable ? (
            <div class="flex items-center justify-between rounded-lg border border-warning/40 bg-base-900 p-4 text-sm">
              <span>
                A newer Azure DevOps MCP is available: <span class="font-mono">{up.adopted}</span> →{" "}
                <span class="font-mono text-warning">{up.latest}</span>
              </span>
              <button hx-post="/app/upstream/adopt" hx-swap="none" hx-confirm="Adopt the new version and restart all upstream children?" class="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover">
                Update now
              </button>
            </div>
          ) : null}
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Connections" value={conns.length} href="/app/connections" />
            <Stat label="API tokens" value={tokens.length} href="/app/tokens" />
            <Stat label="Connected clients" value={clients.length} href="/app/clients" />
          </div>
          <Card title="MCP endpoint">
            <p class="text-sm text-text-muted">
              Point your MCP client at <span class="font-mono">{c.var.publicOrigin}/mcp</span>. Tools are namespaced
              <span class="font-mono"> &lt;slug&gt;__&lt;tool&gt;</span>; call <span class="font-mono">list_connections</span> to discover them.
            </p>
          </Card>
          <Card title="Upstream server">
            <p class="text-sm text-text-muted">
              Microsoft <span class="font-mono">@azure-devops/mcp</span> — running <span class="font-mono">{up.adopted}</span>
              {up.latest ? <> · latest <span class="font-mono">{up.latest}</span> (checked {ago(up.checkedAt)})</> : <> · not yet checked</>}
              {config.adoMcpAutoUpdate ? " · auto-update on" : ""}
            </p>
          </Card>
        </div>
      </Layout>,
    );
  });

  app.post("/upstream/adopt", async (c) => {
    const userId = c.var.session!.user_id;
    const up = upstreamStatus(db, config);
    if (up.latest && up.updateAvailable) {
      await adoptVersion(db, up.latest, runtime.supervisor);
      recordAdmin(db, userId, "upstream.adopt", { detail: up.latest });
    }
    c.header("HX-Refresh", "true");
    return c.body(null, 200);
  });

  return app;
}
