# Azure DevOps MCP (multi-user wrapper)

A self-hosted, single-container service that exposes Microsoft's official
[Azure DevOps MCP server](https://github.com/microsoft/azure-devops-mcp) to AI
agents over an **authenticated remote endpoint**. It handles auth (passkeys for
people, OAuth 2.1 / API tokens for agents) and **per-user Azure DevOps PATs**,
and passes MCP tool calls straight through to Microsoft's server.

It is **multi-user with no admin**: anyone who can reach it self-registers and
manages their own connections. A user's PAT is never reachable by another user.

## How it works

Microsoft's `@azure-devops/mcp` is a stdio process that holds exactly **one PAT**
(`PERSONAL_ACCESS_TOKEN`, base64 `email:pat`) and targets **one organization**
(a positional arg), via `--authentication pat`. A shared child therefore cannot
serve multiple users without leaking PATs. So this wrapper:

- spawns **one Microsoft-MCP child per connection** (`{org, PAT}`), lazily and
  kept warm, with that connection's PAT injected into *only* that child's env;
- fronts agents with a single `/mcp` endpoint (Streamable HTTP + bearer auth)
  that, per request, builds a proxy bound to exactly one authenticated user;
- forwards `tools/*` and `prompts/*` to the user's children, **namespaced** as
  `<slug>__<tool>`, and audits every call.

```
agent ──Bearer──▶ /mcp ──(user-scoped proxy)──▶ child(orgA, userX PAT)
                                              └─▶ child(orgB, userY PAT)
```

### The never-bleed guarantee

- Every bearer credential resolves to a `user_id`. The proxy is built per request
  and bound to that one user.
- `tools/list` only iterates that user's connections; `tools/call` re-validates
  the slug belongs to the user before routing (`src/mcp/proxy.ts`).
- Children are keyed by `connection_id`, which is only ever obtained via
  `WHERE user_id = ?`. There is no code path from one user's request to another
  user's connection or PAT.
- PATs are encrypted at rest with AES-256-GCM under `MASTER_KEY`
  (`src/crypto.ts`), decrypted only in memory at child spawn, never logged.
- `test/isolation.integration.test.ts` boots the app with two users and proves a
  user can't list or call another user's tools, even by guessing the slug.

## Live status wall

The root path `/` is a public, no-auth dashboard showing **aggregate, anonymous**
activity across all accounts: lifetime tool calls, calls/min, p50/p95 latency,
error rate, a 60-second sparkline, active upstream children, and a live feed of
recent calls (generic upstream tool names only — never users, orgs, slugs, args,
or PATs). It updates over SSE (`/status/stream`); `/status/json` is the snapshot.

Counters live in memory (`src/metrics.ts`), flush to the DB every 30s (lifetime
totals survive restarts), and push to connected browsers every 2s.

## Quick start (dev)

```sh
bun install
mise run dev   # http://localhost:3000
```

`mise run dev` sets `ALLOW_DEV_MASTER_KEY=1`, which opts into a built-in
`"DEVELOPMENT"` key so locally stored PATs survive restarts. **Any deployment
without `MASTER_KEY` and without that explicit flag refuses to boot** — so a
misconfigured server can never silently encrypt real PATs with the public dev key.

Open `/register`, create a passkey, then add a connection (org + PAT) on the
Connections page. Create an API token on the Tokens page and point a client at it:

```sh
claude mcp add --transport http azure-devops http://localhost:3000/mcp \
  --header "Authorization: Bearer <token>"
```

Ask the agent to call `list_connections`, then `<slug>__<tool>`.

## Deploy

Single container. Put it behind a TLS-terminating proxy/tunnel that sets
`X-Forwarded-Proto`/`X-Forwarded-Host` (passkeys need a secure origin). Sample composes in [`deploy/`](deploy/):

- [`docker-compose.yml`](deploy/docker-compose.yml) — direct (publishes port 3000)
- [`docker-compose.cloudflared.yml`](deploy/docker-compose.cloudflared.yml) — behind a Cloudflare Tunnel
- [`docker-compose.gatecrash.yml`](deploy/docker-compose.gatecrash.yml) — behind a self-hosted [Gatecrash](https://github.com/jclement/gatecrash) tunnel

> **Open registration:** anyone who can reach the URL can create an account.
> PATs stay isolated per user, but the **network boundary is your real
> perimeter** — front it with a VPN / private ingress / Cloudflare Access.

> **Back up `MASTER_KEY`.** Losing it makes every stored PAT unrecoverable.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `MASTER_KEY` | (required) | 32-byte base64/hex key; encrypts PATs at rest. Required unless `ALLOW_DEV_MASTER_KEY=1` |
| `ALLOW_DEV_MASTER_KEY` | `0` | Local dev only: opt into the built-in insecure key when `MASTER_KEY` is unset |
| `PUBLIC_URL` | unset (derive from proxy) | Hard-pin the public origin/rpID |
| `PORT` | `3000` | Listen port |
| `ADO_MCP_VERSION` | `latest` | Upstream `@azure-devops/mcp` version to spawn |
| `ADO_MCP_DIST_TAG` | `latest` | npm dist-tag the updater tracks |
| `ADO_MCP_AUTO_UPDATE` | `0` | Auto-adopt newer upstream versions and recycle children |
| `CHILD_IDLE_MS` | `600000` | Reap idle upstream children after this |
| `AUTH_RESET` | `0` | Wipe all passkeys + sessions on boot |

## Upstream auto-update

A background checker polls npm for `@azure-devops/mcp` and surfaces "update
available" on the dashboard; one click adopts it and recycles all children onto
the new version. With `ADO_MCP_AUTO_UPDATE=1` it adopts automatically
(`src/updater.ts`).

## Development

```sh
mise run test        # bun test
mise run typecheck   # tsc --noEmit
mise run build       # CSS + bundle to dist/
mise run docker:build
```

Tests use `test/fake-ado-mcp.ts` — a tiny stdio MCP server that stands in for
Microsoft's, so no real org/PAT is needed.
