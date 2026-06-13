import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Layout, Card } from "../layout.tsx";
import type { AuthEnv } from "../../auth/middleware.ts";
import { listAudit, type AuditEntry, type AuditSource } from "../../audit.ts";

function when(unix: number): string {
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function Row(props: { e: AuditEntry }) {
  const e = props.e;
  const color = e.status === "error" ? "text-danger" : "text-text";
  return (
    <tr class="border-b border-base-800 align-top">
      <td class="py-1.5 pr-4 whitespace-nowrap text-text-muted">{when(e.ts)}</td>
      <td class="py-1.5 pr-4 whitespace-nowrap text-text-muted">{e.actor_name}</td>
      <td class="py-1.5 pr-4 whitespace-nowrap font-mono text-text-muted">{e.connection ?? "—"}</td>
      <td class={`py-1.5 pr-4 whitespace-nowrap font-mono ${color}`}>{e.event}</td>
      <td class="py-1.5 pr-4 text-text-muted">{e.target ?? ""}</td>
      <td class="py-1.5 text-text-muted">{e.detail ?? ""}</td>
    </tr>
  );
}

function Table(props: { entries: AuditEntry[] }) {
  if (props.entries.length === 0) return <p class="text-sm text-text-muted">No activity yet.</p>;
  return (
    <table class="w-full text-xs">
      <thead>
        <tr class="border-b border-base-700 text-left text-text-muted">
          <th class="py-2 pr-4 font-medium">Time</th>
          <th class="py-2 pr-4 font-medium">Actor</th>
          <th class="py-2 pr-4 font-medium">Connection</th>
          <th class="py-2 pr-4 font-medium">Event</th>
          <th class="py-2 pr-4 font-medium">Target</th>
          <th class="py-2 font-medium">Detail</th>
        </tr>
      </thead>
      <tbody>{props.entries.map((e) => <Row e={e} />)}</tbody>
    </table>
  );
}

export function activityRouter(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => {
    const userId = c.var.session!.user_id;
    const sourceParam = c.req.query("source");
    const source = (["agent", "security", "config"] as const).includes(sourceParam as AuditSource)
      ? (sourceParam as AuditSource)
      : undefined;
    const entries = listAudit(db, { userId, limit: 200, source });
    return c.html(
      <Layout title="Activity" activeNav="/app/activity">
        <div class="space-y-6">
          <h1 class="text-xl font-semibold">Activity</h1>
          <Card>
            <div class="mb-4 flex gap-2 text-sm">
              <a href="/app/activity" class={!source ? "text-text" : "text-text-muted hover:text-text"}>All</a>
              <a href="/app/activity?source=agent" class={source === "agent" ? "text-text" : "text-text-muted hover:text-text"}>Agent</a>
              <a href="/app/activity?source=security" class={source === "security" ? "text-text" : "text-text-muted hover:text-text"}>Security</a>
              <a href="/app/activity?source=config" class={source === "config" ? "text-text" : "text-text-muted hover:text-text"}>Config</a>
            </div>
            <div class="overflow-x-auto">
              <Table entries={entries} />
            </div>
          </Card>
        </div>
      </Layout>,
    );
  });

  return app;
}
