# CLAUDE.md

Guidance for working in this repo. Read this before making changes.

## What this is

A self-hosted, single-container **multi-user** wrapper that fronts Microsoft's
`@azure-devops/mcp` server over an authenticated remote MCP endpoint. It adds
passkey auth (people), OAuth 2.1 + API tokens (agents), per-user Azure DevOps
PATs (encrypted at rest), an audit log, and an upstream auto-updater. Runtime is
**Bun + TypeScript + Hono**; UI is **server-rendered Hono JSX + HTMX + Tailwind
v4**; state is **bun:sqlite**. Modeled on the sibling `devops-mcp` (Obsidian)
project's conventions.

## Commands

`mise run dev` (hot reload), `mise run test` (`bun test`), `mise run typecheck`
(`tsc --noEmit`), `mise run build`, `mise run docker:build`. Direct: `bun test`,
`bun test test/isolation.integration.test.ts`. **Run `bunx tsc --noEmit` and
`bun test` before committing.** Dev needs `MASTER_KEY` set (or it uses a
throwaway key and warns).

## The core constraint

Microsoft's server is **one PAT, one org, stdio** (`npx -y @azure-devops/mcp
<org> --authentication pat`, PAT via `PERSONAL_ACCESS_TOKEN` = base64
`email:pat`). So we run **one child per connection** and proxy to it. **A user's
PAT must never be reachable by another user** — this is the invariant the whole
design protects. If you touch routing, auth, or the supervisor, keep
`test/isolation.integration.test.ts` green.

## Architecture (`src/`)

- `server.ts` — boot: config → migrate DB → `ChildSupervisor` → update checker →
  `Bun.serve` → SIGTERM (kills all children, closes db). `app.tsx` — Hono wiring,
  middleware order, `/mcp` endpoint.
- `config.ts` — env parsing incl. `MASTER_KEY`, `ADO_MCP_VERSION`. `crypto.ts` —
  AES-256-GCM seal/open for PATs.
- `auth/` — `webauthn.ts` (multi-user passkeys; register creates a new user,
  login resolves the owner), `sessions.ts`, `tokens.ts` (static + OAuth bearer,
  `AuthPrincipal.userId` is the tenant), `middleware.ts`.
- `oauth/` — hand-rolled OAuth 2.1 AS; clients are global, **consent + grants are
  per-user** (`oauth_consents`, `oauth_grants.user_id`).
- `connections/store.ts` — connections CRUD; PAT seal/open; **every query scoped
  to `user_id`**.
- `mcp/` — `proxy.ts` (per-user `Server`, namespacing `<slug>__<tool>`, the
  tenant-isolation chokepoint in `tools/call`), `supervisor.ts` (child pool keyed
  by `connection_id`), `upstream.ts` (spawn spec), `respond.ts`, `runtime.ts`.
- `updater.ts` — polls npm for `@azure-devops/mcp`; adopt + recycle children.
- `web/` — `layout.tsx`, `origin.ts`, `routes/*.tsx` (register, login, dashboard,
  connections, tokens, clients, activity, account, consent). All scoped to
  `c.var.session!.user_id`.
- `db/` — `index.ts` (open + numbered migrations + settings KV),
  `migrations/0001_init.sql`.

## Conventions

- **Tenant scoping is non-negotiable.** Any new query touching user data takes a
  `userId` and filters by it. Any new MCP capability forwarded through the proxy
  must resolve connections only via the authenticated `userId`.
- **PAT hygiene:** never log or persist a plaintext PAT; decrypt only at spawn.
- **Schema changes** are new numbered migrations in `src/db/migrations/` — never
  edit an applied one. Simple config goes in the `settings` KV via
  `getSetting`/`setSetting`.
- **UI:** Hono JSX SSR + HTMX (vendored in `public/vendor/`, no CDN). If you add
  or change Tailwind classes, rebuild CSS (`bunx @tailwindcss/cli -i styles/app.css
  -o public/app.css`) — `public/app.css` is a gitignored build artifact.
- **Imports:** ESM with explicit `.ts`/`.tsx` extensions; JSX files are `.tsx`.
- **Tests:** `bun:test`. Use `test/helpers.ts` (`bootTestApp`, `createTestUser`,
  `fakeSpawnFactory`) and `test/fake-ado-mcp.ts` (a stand-in stdio MCP server) so
  no real org/PAT is needed. The supervisor's spawn command is injectable for
  exactly this reason — keep it that way.

## Upstream coupling

The Microsoft server is 0.x and its CLI flags can drift. All knowledge of how to
launch it lives in `src/mcp/upstream.ts` (argv + env) — change flags only there.
The `--domains` toolset filter is best-effort; verify the flag name against the
installed upstream version if connections fail to start.

## Gotchas

- Env vars are read at boot; `bun --watch` reloads code but not env — restart
  `mise run dev` to change them.
- Losing `MASTER_KEY` makes all stored PATs unrecoverable. Rotating it requires
  re-encrypting every `connections` row.
- Registration is open by design (no admin). The network boundary is the
  perimeter; don't add an admin concept without a reason.
