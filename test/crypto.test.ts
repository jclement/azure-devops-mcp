import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { openPat, patLast4, sealPat } from "../src/crypto.ts";

describe("PAT encryption", () => {
  const key = randomBytes(32);

  test("round-trips a PAT", () => {
    const pat = "abcdefghijklmnopqrstuvwxyz0123456789";
    const sealed = sealPat(key, pat);
    expect(openPat(key, sealed)).toBe(pat);
  });

  test("uses a fresh nonce per seal", () => {
    const a = sealPat(key, "same");
    const b = sealPat(key, "same");
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  test("fails to open with the wrong key", () => {
    const sealed = sealPat(key, "secret");
    expect(() => openPat(randomBytes(32), sealed)).toThrow();
  });

  test("fails to open if the ciphertext is tampered", () => {
    const sealed = sealPat(key, "secret");
    sealed.ciphertext.fill(0); // corrupt → GCM tag check fails
    expect(() => openPat(key, sealed)).toThrow();
  });

  test("patLast4 returns the tail", () => {
    expect(patLast4("xxxxabcd")).toBe("abcd");
  });
});
