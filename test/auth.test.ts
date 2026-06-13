import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db/index.ts";
import { createApiToken, revokeApiToken, verifyBearer } from "../src/auth/tokens.ts";
import { createTestUser, bootTestApp, type TestApp } from "./helpers.ts";

describe("token tenant scoping", () => {
  let db: Database;
  beforeEach(() => (db = openDatabase(":memory:")));
  afterEach(() => db.close());

  test("verifyBearer resolves the owning user", () => {
    const a = createTestUser(db, "A");
    const b = createTestUser(db, "B");
    const ta = createApiToken(db, a, "ta").token;
    const tb = createApiToken(db, b, "tb").token;
    expect(verifyBearer(db, ta)?.userId).toBe(a);
    expect(verifyBearer(db, tb)?.userId).toBe(b);
  });

  test("a user cannot revoke another user's token", () => {
    const a = createTestUser(db, "A");
    const b = createTestUser(db, "B");
    const { token, row } = createApiToken(db, a, "ta");
    expect(revokeApiToken(db, b, row.id)).toBe(false); // wrong tenant
    expect(verifyBearer(db, token)).not.toBeNull();
    expect(revokeApiToken(db, a, row.id)).toBe(true);
    expect(verifyBearer(db, token)).toBeNull();
  });
});

describe("HTTP surface", () => {
  let app: TestApp;
  beforeEach(async () => (app = await bootTestApp()));
  afterEach(async () => await app.close());

  test("/healthz is open", async () => {
    const res = await fetch(`${app.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("/mcp requires a bearer token", async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  test("/mcp rejects an invalid token", async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer adomcp_nope" },
    });
    expect(res.status).toBe(401);
  });

  test("OAuth metadata is served", async () => {
    const res = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { token_endpoint: string };
    expect(meta.token_endpoint).toBe("http://localhost:3000/oauth/token");
  });
});
