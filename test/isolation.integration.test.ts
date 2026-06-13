import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { bootTestApp, createTestUser, type TestApp } from "./helpers.ts";
import { createConnection } from "../src/connections/store.ts";
import { createApiToken } from "../src/auth/tokens.ts";

let app: TestApp;
let clientA: Client;
let clientB: Client;

function jsonOf(result: CallToolResult): any {
  const block = result.content.find((c) => c.type === "text");
  return block && block.type === "text" ? JSON.parse(block.text) : null;
}
function textOf(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}

async function connect(baseUrl: string, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

beforeAll(async () => {
  app = await bootTestApp();
  const { db, config } = app;

  const userA = createTestUser(db, "Alice");
  const userB = createTestUser(db, "Bob");
  createConnection(db, config.masterKey, userA, { org: "orgA", slug: "alpha", pat: "PAT-ALICE-aaaa" });
  createConnection(db, config.masterKey, userB, { org: "orgB", slug: "beta", pat: "PAT-BOB-bbbb" });

  const tokenA = createApiToken(db, userA, "alice-cli").token;
  const tokenB = createApiToken(db, userB, "bob-cli").token;
  clientA = await connect(app.baseUrl, tokenA);
  clientB = await connect(app.baseUrl, tokenB);
});

afterAll(async () => {
  await clientA?.close();
  await clientB?.close();
  await app?.close();
});

describe("tenant isolation", () => {
  test("each user sees only their own namespaced tools", async () => {
    const a = (await clientA.listTools()).tools.map((t) => t.name).sort();
    expect(a).toContain("list_connections");
    expect(a).toContain("alpha__whoami");
    expect(a).toContain("alpha__echo");
    expect(a.some((n) => n.startsWith("beta__"))).toBe(false);

    const b = (await clientB.listTools()).tools.map((t) => t.name);
    expect(b).toContain("beta__whoami");
    expect(b.some((n) => n.startsWith("alpha__"))).toBe(false);
  });

  test("list_connections returns only the caller's connections", async () => {
    const result = (await clientA.callTool({ name: "list_connections" })) as CallToolResult;
    expect(jsonOf(result)).toEqual([{ slug: "alpha", organization: "orgA" }]);
  });

  test("a tool call reaches a child holding THIS user's PAT", async () => {
    const result = (await clientA.callTool({ name: "alpha__whoami" })) as CallToolResult;
    const who = jsonOf(result);
    expect(who.org).toBe("orgA");
    expect(who.pat.patTail).toBe("aaaa"); // tail of PAT-ALICE-aaaa
  });

  test("PATs never cross: Bob's child holds Bob's PAT, not Alice's", async () => {
    const result = (await clientB.callTool({ name: "beta__whoami" })) as CallToolResult;
    const who = jsonOf(result);
    expect(who.org).toBe("orgB");
    expect(who.pat.patTail).toBe("bbbb");
  });

  test("a user cannot call another user's connection — even by guessing the slug", async () => {
    const result = (await clientA.callTool({ name: "beta__whoami" })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("UNKNOWN_CONNECTION");
  });

  test("unprefixed tool names are rejected", async () => {
    const result = (await clientA.callTool({ name: "whoami" })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("INVALID_TOOL");
  });

  test("audit log records the call under the right user", async () => {
    const rows = app.db
      .query<{ user_id: number; connection: string; event: string; status: string }, []>(
        "SELECT user_id, connection, event, status FROM audit_log WHERE source = 'agent' AND event = 'whoami' ORDER BY id",
      )
      .all();
    // Alice's orgA call and Bob's orgB call both recorded, each under its own user
    const alice = rows.find((r) => r.connection === "alpha");
    const bob = rows.find((r) => r.connection === "beta");
    expect(alice).toBeTruthy();
    expect(bob).toBeTruthy();
    expect(alice!.user_id).not.toBe(bob!.user_id);
  });
});
