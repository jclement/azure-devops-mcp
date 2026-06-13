import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card, ago } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { listUserOAuthClients, revokeUserClient, type OAuthClientView } from "../../oauth/router.ts";
import { recordAdmin } from "../../audit.ts";

function ClientList(props: { clients: OAuthClientView[] }) {
  if (props.clients.length === 0) {
    return <p class="text-sm text-text-muted">No connected AI clients. They appear here after you approve an OAuth connection.</p>;
  }
  return (
    <ul class="divide-y divide-base-800">
      {props.clients.map((cl) => (
        <li class="flex items-center justify-between py-3">
          <div>
            <div class="text-sm font-medium">{cl.client_name}</div>
            <div class="text-xs text-text-muted">
              Approved {ago(cl.consented_at)} · {cl.grants.length} active grant{cl.grants.length === 1 ? "" : "s"}
            </div>
          </div>
          <button
            hx-delete={`/app/clients/${cl.client_id}`}
            hx-confirm={`Revoke '${cl.client_name}'? It loses access immediately and must re-authorize.`}
            hx-target="#client-list"
            class="text-sm text-danger hover:underline"
          >
            Revoke
          </button>
        </li>
      ))}
    </ul>
  );
}

export function clientsRouter(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => {
    const userId = c.var.session!.user_id;
    return c.html(
      <Layout title="Clients" activeNav="/app/clients">
        <div class="space-y-6">
          <h1 class="text-xl font-semibold">Connected AI clients</h1>
          <Card title="OAuth clients you've authorized">
            <div id="client-list">
              <ClientList clients={listUserOAuthClients(db, userId)} />
            </div>
          </Card>
        </div>
      </Layout>,
    );
  });

  app.delete("/:clientId", (c) => {
    const userId = c.var.session!.user_id;
    const clientId = c.req.param("clientId");
    const name = listUserOAuthClients(db, userId).find((x) => x.client_id === clientId)?.client_name ?? clientId;
    revokeUserClient(db, userId, clientId);
    recordAdmin(db, userId, "oauth.revoke", { target: name });
    return c.html(<ClientList clients={listUserOAuthClients(db, userId)} />);
  });

  return app;
}
