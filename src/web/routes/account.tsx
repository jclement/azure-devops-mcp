import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { Database } from "bun:sqlite";
import { Layout, Card, ago } from "../layout.tsx";
import { SESSION_COOKIE, type AuthEnv } from "../../auth/middleware.ts";
import {
  deletePasskey,
  finishRegistration,
  getUser,
  listPasskeys,
  renamePasskey,
  startRegistration,
  type PasskeyRow,
} from "../../auth/webauthn.ts";
import { deleteOtherSessions } from "../../auth/sessions.ts";
import { recordAdmin } from "../../audit.ts";

function PasskeyList(props: { passkeys: PasskeyRow[] }) {
  return (
    <ul class="divide-y divide-base-800">
      {props.passkeys.map((p) => (
        <li class="flex items-center justify-between py-3">
          <div>
            <div class="text-sm font-medium">{p.name}</div>
            <div class="text-xs text-text-muted">Added {ago(p.created_at)} · last used {ago(p.last_used_at)}</div>
          </div>
          {props.passkeys.length > 1 ? (
            <button
              hx-delete={`/app/account/passkeys/${p.id}`}
              hx-confirm={`Delete passkey '${p.name}'?`}
              hx-target="#passkey-list"
              class="text-sm text-danger hover:underline"
            >
              Delete
            </button>
          ) : (
            <span class="text-xs text-text-muted">last passkey</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function accountRouter(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => {
    const userId = c.var.session!.user_id;
    const user = getUser(db, userId);
    return c.html(
      <Layout title="Account" activeNav="/app/account" userName={user?.display_name}>
        <div class="space-y-6">
          <h1 class="text-xl font-semibold">Account</h1>
          <Card title="Profile">
            <form hx-post="/app/account/name" hx-swap="none" class="flex gap-3">
              <input name="display_name" value={user?.display_name ?? ""} required class="flex-1 rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
              <button type="submit" class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">Save</button>
            </form>
          </Card>
          <Card title="Passkeys">
            <div id="passkey-list">
              <PasskeyList passkeys={listPasskeys(db, userId)} />
            </div>
            <form id="add-passkey-form" class="mt-4 flex gap-3">
              <input id="add-passkey-name" placeholder="New passkey name" class="flex-1 rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none" />
              <button type="submit" class="rounded-md border border-base-600 px-4 py-2 text-sm hover:bg-base-800">Add passkey</button>
            </form>
            <p id="add-passkey-status" class="mt-2 hidden text-sm text-text-muted"></p>
          </Card>
          <Card title="Sessions & danger zone">
            <div class="flex flex-wrap gap-3">
              <button hx-post="/app/account/sessions/revoke-others" hx-swap="none" class="rounded-md border border-base-600 px-4 py-2 text-sm hover:bg-base-800">Sign out other sessions</button>
              <button hx-delete="/app/account" hx-confirm="Delete your account, all connections (and their PATs), tokens and grants? This cannot be undone." class="rounded-md border border-danger/50 px-4 py-2 text-sm text-danger hover:bg-base-800">Delete account</button>
            </div>
          </Card>
        </div>
        <script src="/assets/vendor/simplewebauthn-browser.min.js"></script>
        <script src="/assets/auth-client.js"></script>
      </Layout>,
    );
  });

  app.post("/name", async (c) => {
    const userId = c.var.session!.user_id;
    const body = await c.req.parseBody();
    const name = String(body.display_name ?? "").trim().slice(0, 80);
    if (name) {
      db.query("UPDATE users SET display_name = ? WHERE id = ?").run(name, userId);
      recordAdmin(db, userId, "account.rename", { target: name });
    }
    return c.body(null, 204);
  });

  // add-passkey ceremony (existing user)
  app.post("/passkeys/options", async (c) => {
    const userId = c.var.session!.user_id;
    const { options, challengeId } = await startRegistration(db, { rpId: c.var.rpId, origin: c.var.publicOrigin }, { userId });
    return c.json({ options, challengeId });
  });

  app.post("/passkeys/verify", async (c) => {
    const userId = c.var.session!.user_id;
    const body = await c.req.json().catch(() => ({}));
    // Adding to an existing user: the handle is unused (no user row is created),
    // and the challenge comes from the prior /passkeys/options call.
    const result = await finishRegistration(
      db,
      { rpId: c.var.rpId, origin: c.var.publicOrigin },
      body.response,
      body.challengeId,
      String(body.name ?? "").trim() || "New passkey",
      new Uint8Array(0),
      { userId },
    );
    if ("error" in result) return c.json(result, 400);
    recordAdmin(db, userId, "passkey.add", { target: String(body.name ?? "") });
    return c.json({ ok: true });
  });

  app.delete("/passkeys/:id", (c) => {
    const userId = c.var.session!.user_id;
    const res = deletePasskey(db, userId, c.req.param("id"));
    if ("error" in res) c.header("HX-Reswap", "none");
    else recordAdmin(db, userId, "passkey.delete", { target: c.req.param("id") });
    return c.html(<PasskeyList passkeys={listPasskeys(db, userId)} />);
  });

  app.post("/sessions/revoke-others", (c) => {
    const userId = c.var.session!.user_id;
    deleteOtherSessions(db, userId, c.var.sessionCookie!);
    recordAdmin(db, userId, "session.revoke_others");
    return c.body(null, 204);
  });

  app.delete("/", (c) => {
    const userId = c.var.session!.user_id;
    // ON DELETE CASCADE removes connections, tokens, grants, passkeys, sessions.
    db.query("DELETE FROM users WHERE id = ?").run(userId);
    recordAdmin(db, null, "account.delete", { detail: `user ${userId}` });
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    c.header("HX-Redirect", "/register");
    return c.body(null, 200);
  });

  return app;
}
