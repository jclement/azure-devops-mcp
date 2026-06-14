import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Database } from "bun:sqlite";
import type { Config } from "../../config.ts";
import { Layout } from "../layout.tsx";
import { SESSION_COOKIE, type AuthEnv } from "../../auth/middleware.ts";
import { createSession } from "../../auth/sessions.ts";
import { finishRegistration, startRegistration } from "../../auth/webauthn.ts";
import { recordAdmin } from "../../audit.ts";

/**
 * Open self-service registration: anyone who can reach this server may create an
 * account. Each registration mints a brand-new, isolated user. The deployment's
 * network boundary (VPN / private ingress) is the real perimeter.
 */
function RegisterPage() {
  return (
    <Layout title="Create account" nav={false}>
      <div class="mx-auto mt-24 max-w-md rounded-lg border border-base-700 bg-base-900 p-8">
        <div class="mb-6 flex items-center gap-3">
          <img src="/assets/logo.svg" alt="" class="h-8 w-8" />
          <h1 class="text-lg font-semibold">Create your account</h1>
        </div>
        <p class="mb-6 text-sm text-text-muted">
          Register a passkey to create your own isolated account. You'll add Azure DevOps connections (organization +
          PAT) after signing in. Already have an account? <a href="/login" class="text-accent hover:underline">Sign in</a>.
        </p>
        <form id="register-form" class="space-y-4">
          <div>
            <label class="mb-1 block text-sm text-text-muted" for="register-name">Display name</label>
            <input
              id="register-name"
              type="text"
              required
              autocomplete="name"
              placeholder="e.g. Jane Dev"
              class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label class="mb-1 block text-sm text-text-muted" for="register-passkey-name">Passkey name</label>
            <input
              id="register-passkey-name"
              type="text"
              placeholder="e.g. MacBook Touch ID"
              class="w-full rounded-md border border-base-600 bg-base-800 px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>
          <button type="submit" class="w-full rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover">
            Create passkey
          </button>
          <p id="register-status" class="hidden text-sm text-text-muted"></p>
        </form>
        <p class="mt-6 text-xs text-text-muted">
          This is a personal, best-effort project — no legal guarantee is made about the safety of stored
          credentials. New here? <a href="/help" class="text-accent hover:underline">What is this?</a> · See the{" "}
          <a href="/privacy" class="text-accent hover:underline">privacy &amp; disclaimer</a>.
        </p>
      </div>
      <script src="/assets/vendor/simplewebauthn-browser.min.js"></script>
      <script src="/assets/auth-client.js"></script>
    </Layout>
  );
}

export function registerRouter(db: Database, _config: Config): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", (c) => c.html(<RegisterPage />));

  app.post("/webauthn/options", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const displayName = String(body.displayName ?? "").trim();
    if (!displayName) return c.json({ error: "A display name is required." }, 400);
    const { options, challengeId } = await startRegistration(
      db,
      { rpId: c.var.rpId, origin: c.var.publicOrigin },
      { displayName },
    );
    return c.json({ options, challengeId });
  });

  app.post("/webauthn/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const displayName = String(body.displayName ?? "").trim();
    if (!displayName) return c.json({ error: "A display name is required." }, 400);
    // For a new user the handle is server-chosen and only stored (registration
    // verification checks challenge/origin/rpID, not the handle), so a fresh
    // random handle here is fine; the challenge comes from the prior options call.
    const userHandle = new Uint8Array(randomBytes(16));
    const result = await finishRegistration(
      db,
      { rpId: c.var.rpId, origin: c.var.publicOrigin },
      body.response,
      body.challengeId,
      String(body.name ?? "").trim() || "First passkey",
      userHandle,
      { displayName },
    );
    if ("error" in result) return c.json(result, 400);
    recordAdmin(db, result.userId, "account.create", { detail: `rpID ${c.var.rpId}` });
    const session = createSession(db, result.userId, c.req.header("user-agent"));
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: c.var.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 3600,
    });
    return c.json({ ok: true });
  });

  return app;
}
