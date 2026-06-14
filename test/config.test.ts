import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.ts";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("master key handling", () => {
  test("refuses to boot without MASTER_KEY and without the dev opt-in", () => {
    expect(() => loadConfig(env({}))).toThrow(/MASTER_KEY is required/);
    // NODE_ENV must NOT relax this — the dev key requires an explicit opt-in
    expect(() => loadConfig(env({ NODE_ENV: "development" }))).toThrow(/MASTER_KEY is required/);
  });

  test("uses the built-in dev key only with explicit opt-in", () => {
    const c = loadConfig(env({ ALLOW_DEV_MASTER_KEY: "1" }));
    expect(c.masterKey.length).toBe(32);
    expect(c.masterKeyEphemeral).toBe(true);
  });

  test("accepts a real 32-byte base64 key", () => {
    const c = loadConfig(env({ MASTER_KEY: randomBytes(32).toString("base64") }));
    expect(c.masterKey.length).toBe(32);
    expect(c.masterKeyEphemeral).toBe(false);
  });

  test("rejects a wrong-length key", () => {
    expect(() => loadConfig(env({ MASTER_KEY: randomBytes(16).toString("base64") }))).toThrow(/32 bytes/);
  });
});
