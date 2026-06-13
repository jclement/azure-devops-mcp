import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for Azure DevOps PATs at rest.
 *
 * AES-256-GCM under the server MASTER_KEY (config.masterKey). Each PAT gets a
 * fresh 12-byte nonce; the 16-byte GCM auth tag is stored alongside. The
 * plaintext PAT exists only transiently in memory at child-spawn time — it is
 * never written to disk or logs. Losing MASTER_KEY makes every PAT
 * unrecoverable (by design: the server cannot read PATs without it).
 */
export interface SealedPat {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

export function sealPat(key: Buffer, plaintext: string): SealedPat {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, nonce, tag };
}

export function openPat(key: Buffer, sealed: SealedPat): string {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
  decipher.setAuthTag(sealed.tag);
  const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Last 4 chars of a PAT, for non-sensitive UI display ("…ab12"). */
export function patLast4(pat: string): string {
  return pat.slice(-4);
}
