import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { csrf } from "hono/csrf";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Config } from "./config.ts";
import type { ProxyRuntime } from "./mcp/runtime.ts";
import { createProxyServer } from "./mcp/proxy.ts";
import { firstText } from "./mcp/respond.ts";
import {
  hostGuard,
  mcpOriginGuard,
  rateLimit,
  requireBearer,
  requireSession,
  resolveOriginMiddleware,
  securityHeaders,
  type AuthEnv,
} from "./auth/middleware.ts";
import { abortRegistry, hashToken } from "./auth/tokens.ts";
import { oauthInteractiveRouter, oauthPublicRouter, wellKnownRouter } from "./oauth/router.ts";
import { registerRouter } from "./web/routes/register.tsx";
import { loginRouter } from "./web/routes/login.tsx";
import { dashboardRouter } from "./web/routes/dashboard.tsx";
import { connectionsRouter } from "./web/routes/connections.tsx";
import { tokensRouter } from "./web/routes/tokens.tsx";
import { clientsRouter } from "./web/routes/clients.tsx";
import { activityRouter } from "./web/routes/activity.tsx";
import { accountRouter } from "./web/routes/account.tsx";
import { StatusLanding, statusRouter, snapshot } from "./web/routes/status.tsx";
import { recordMcpCall } from "./audit.ts";
import type { Metrics } from "./metrics.ts";

export interface AppDeps {
  config: Config;
  db: Database;
  runtime: ProxyRuntime;
  metrics: Metrics;
}

export type AppEnv = AuthEnv & { Variables: AuthEnv["Variables"] & { deps: AppDeps } };

export function createApp(deps: AppDeps) {
  const { config, db, runtime, metrics } = deps;
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("*", securityHeaders());
  app.use("*", resolveOriginMiddleware(config));
  app.use("*", hostGuard(db, config));

  const sameOriginCsrf = csrf({ origin: (origin, c) => origin === c.get("publicOrigin") });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("/assets/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/assets/, "") }));

  // --- Public live status (no auth; aggregate + anonymous) ---
  app.use("/status/*", rateLimit("status", 60));
  app.route("/status", statusRouter(db, runtime, metrics));
  app.get("/", (c) => c.html(<StatusLanding snap={snapshot(db, runtime, metrics)} />));

  // --- OAuth metadata + public endpoints ---
  app.route("/.well-known", wellKnownRouter());
  app.use("/oauth/token", rateLimit("oauth", 30));
  app.use("/oauth/register", rateLimit("oauth", 30));
  app.route("/oauth", oauthPublicRouter(db));

  // --- OAuth interactive (passkey session + consent) ---
  app.use("/oauth/authorize", requireSession(db, { redirect: true }));
  app.use("/oauth/consent", requireSession(db, { redirect: true }), sameOriginCsrf);
  app.route("/oauth", oauthInteractiveRouter(db));

  // --- Registration (open) & login ---
  app.use("/register/*", rateLimit("register", 10));
  app.use("/register", rateLimit("register", 10));
  app.route("/register", registerRouter(db, config));
  app.use("/login/*", rateLimit("login", 10));
  app.use("/logout", sameOriginCsrf);
  app.route("/", loginRouter(db, config));

  // --- MCP endpoint (bearer auth, per-user proxy) ---
  app.use("/mcp", mcpOriginGuard(), requireBearer(db));
  app.all("/mcp", async (c) => {
    const transport = new StreamableHTTPTransport();
    const principal = c.var.principal!;
    const server = createProxyServer({
      db,
      supervisor: runtime.supervisor,
      spawnFactory: runtime.spawnFactory,
      masterKey: runtime.masterKey,
      upstreamVersion: runtime.upstreamVersion,
      principal,
      onCall: (connection, tool, args, result, ms) => {
        recordMcpCall(
          db,
          principal,
          connection,
          tool,
          args,
          result.isError ? "error" : "ok",
          result.isError ? firstText(result) : undefined,
        );
        metrics.recordCall(tool, ms, !result.isError);
      },
    });
    await server.connect(transport);
    // revoking the token kills any live SSE stream for it immediately
    const token = c.var.bearerToken!;
    const unregister = abortRegistry.register(hashToken(token), () => void transport.close());
    transport.onclose = unregister;
    return transport.handleRequest(c);
  });

  // --- Management UI (session + CSRF) ---
  app.use("/app/*", requireSession(db, { redirect: true }), sameOriginCsrf);
  app.use("/app", requireSession(db, { redirect: true }));
  app.route("/app/connections", connectionsRouter(db, runtime));
  app.route("/app/tokens", tokensRouter(db));
  app.route("/app/clients", clientsRouter(db));
  app.route("/app/activity", activityRouter(db));
  app.route("/app/account", accountRouter(db));
  app.route("/app", dashboardRouter(db, config, runtime));

  return app;
}
