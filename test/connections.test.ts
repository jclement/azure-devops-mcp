import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db/index.ts";
import {
  ConnectionError,
  createConnection,
  deleteConnection,
  getConnection,
  getConnectionBySlug,
  listConnections,
  openConnectionPat,
  updateConnectionPat,
} from "../src/connections/store.ts";
import { createTestUser } from "./helpers.ts";

let db: Database;
const key = randomBytes(32);

beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => db.close());

describe("connections store", () => {
  test("creates and lists a connection, scoped to its user", () => {
    const a = createTestUser(db, "A");
    const b = createTestUser(db, "B");
    createConnection(db, key, a, { org: "contoso", pat: "PAT-A-1234" });
    expect(listConnections(db, a).length).toBe(1);
    expect(listConnections(db, b).length).toBe(0);
    expect(listConnections(db, a)[0]!.slug).toBe("contoso");
    expect(listConnections(db, a)[0]!.pat_last4).toBe("1234");
  });

  test("derives a slug and rejects duplicates per user", () => {
    const a = createTestUser(db, "A");
    createConnection(db, key, a, { org: "Contoso Org", pat: "x" });
    expect(listConnections(db, a)[0]!.slug).toBe("contoso-org");
    expect(() => createConnection(db, key, a, { org: "Contoso Org", pat: "y" })).toThrow(ConnectionError);
  });

  test("same slug allowed across different users", () => {
    const a = createTestUser(db, "A");
    const b = createTestUser(db, "B");
    createConnection(db, key, a, { org: "shared", pat: "x" });
    expect(() => createConnection(db, key, b, { org: "shared", pat: "y" })).not.toThrow();
  });

  test("PAT decrypts only for the owning user", () => {
    const a = createTestUser(db, "A");
    const b = createTestUser(db, "B");
    const conn = createConnection(db, key, a, { org: "contoso", pat: "super-secret-pat" });
    expect(openConnectionPat(db, key, a, conn.id)).toBe("super-secret-pat");
    // another user cannot resolve it — the row is filtered by user_id
    expect(openConnectionPat(db, key, b, conn.id)).toBeNull();
    expect(getConnection(db, b, conn.id)).toBeNull();
    expect(getConnectionBySlug(db, b, "contoso")).toBeNull();
  });

  test("rotating the PAT bumps updated_at and re-encrypts", async () => {
    const a = createTestUser(db, "A");
    const conn = createConnection(db, key, a, { org: "contoso", pat: "old" });
    const before = getConnection(db, a, conn.id)!.updated_at;
    await Bun.sleep(1100); // unixepoch has second resolution
    expect(updateConnectionPat(db, key, a, conn.id, "new-pat")).toBe(true);
    expect(openConnectionPat(db, key, a, conn.id)).toBe("new-pat");
    expect(getConnection(db, a, conn.id)!.updated_at).toBeGreaterThan(before);
  });

  test("delete is scoped to the user", () => {
    const a = createTestUser(db, "A");
    const b = createTestUser(db, "B");
    const conn = createConnection(db, key, a, { org: "contoso", pat: "x" });
    expect(deleteConnection(db, b, conn.id)).toBe(false); // wrong user can't delete
    expect(deleteConnection(db, a, conn.id)).toBe(true);
    expect(listConnections(db, a).length).toBe(0);
  });
});
