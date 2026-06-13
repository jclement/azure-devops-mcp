import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { getSetting, setSetting } from "../db/index.ts";

const CHALLENGE_TTL_S = 300;

/** The public origin + relying-party ID for a request (configured or proxy-derived). */
export interface RelyingParty {
  rpId: string;
  origin: string;
}

export interface PasskeyRow {
  id: string;
  user_id: number;
  name: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

function storeChallenge(db: Database, type: "registration" | "authentication", challenge: string): string {
  const id = randomBytes(16).toString("base64url");
  db.query("INSERT INTO webauthn_challenges (id, type, challenge, expires_at) VALUES (?, ?, ?, ?)").run(
    id,
    type,
    challenge,
    Math.floor(Date.now() / 1000) + CHALLENGE_TTL_S,
  );
  return id;
}

/** Single-use challenge consumption. */
function consumeChallenge(db: Database, id: string | undefined, type: "registration" | "authentication"): string | null {
  if (!id) return null;
  const row = db
    .query<{ challenge: string; expires_at: number }, [string, string]>(
      "SELECT challenge, expires_at FROM webauthn_challenges WHERE id = ? AND type = ?",
    )
    .get(id, type);
  if (row) db.query("DELETE FROM webauthn_challenges WHERE id = ?").run(id);
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row.challenge;
}

function toFixedUint8(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

export function listPasskeys(db: Database, userId: number): PasskeyRow[] {
  return db.query<PasskeyRow, [number]>("SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at").all(userId);
}

export function passkeyCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM passkey_credentials").get()!.n;
}

export function userCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n;
}

export function getUser(db: Database, userId: number): { id: number; display_name: string } | null {
  return db.query<{ id: number; display_name: string }, [number]>("SELECT id, display_name FROM users WHERE id = ?").get(userId);
}

/** The rpID this server is pinned to (set at first passkey registration). */
export function pinnedRpId(db: Database): string | null {
  return getSetting(db, "rp_id_at_setup");
}

/** Reject ceremonies under a different host than the one the server was claimed with. */
function checkPin(db: Database, rp: RelyingParty): { error: string } | null {
  const pinned = pinnedRpId(db);
  if (pinned && pinned !== rp.rpId) {
    return {
      error:
        `This server is bound to host '${pinned}', but you are connecting as '${rp.rpId}'. ` +
        `Passkeys are bound to the original host.`,
    };
  }
  return null;
}

export interface RegistrationIntent {
  /** Add a passkey to this existing user (management UI). */
  userId?: number;
  /** Display name for a brand-new user (open self-service registration). */
  displayName?: string;
}

/** Start a passkey registration ceremony (new-user signup or add-passkey). */
export async function startRegistration(db: Database, rp: RelyingParty, intent: RegistrationIntent = {}) {
  let userHandle: Uint8Array<ArrayBuffer>;
  let userName: string;
  let exclude: PasskeyRow[] = [];
  if (intent.userId) {
    const user = db.query<{ user_handle: Uint8Array; display_name: string }, [number]>(
      "SELECT user_handle, display_name FROM users WHERE id = ?",
    ).get(intent.userId);
    if (!user) throw new Error("Unknown user");
    userHandle = toFixedUint8(user.user_handle);
    userName = user.display_name;
    exclude = listPasskeys(db, intent.userId);
  } else {
    userHandle = toFixedUint8(randomBytes(16));
    userName = (intent.displayName ?? "").trim() || "user";
  }
  const options = await generateRegistrationOptions({
    rpName: "Azure DevOps MCP",
    rpID: rp.rpId,
    userID: userHandle,
    userName,
    userDisplayName: userName,
    attestationType: "none",
    excludeCredentials: exclude.map((c) => ({
      id: c.id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const challengeId = storeChallenge(db, "registration", options.challenge);
  return { options, challengeId, userHandle };
}

/**
 * Verify registration. For a new user, creates the user row and returns its id.
 * For add-passkey, attaches the credential to the existing user.
 */
export async function finishRegistration(
  db: Database,
  rp: RelyingParty,
  body: RegistrationResponseJSON,
  challengeId: string | undefined,
  name: string,
  userHandle: Uint8Array,
  intent: RegistrationIntent = {},
): Promise<{ credentialId: string; userId: number } | { error: string }> {
  const pinErr = checkPin(db, rp);
  if (pinErr) return pinErr;
  const challenge = consumeChallenge(db, challengeId, "registration");
  if (!challenge) return { error: "Challenge expired or missing — reload the page and try again." };
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    return { error: `Passkey verification failed: ${err instanceof Error ? err.message : err}` };
  }
  if (!verification.verified || !verification.registrationInfo) return { error: "Passkey verification failed." };
  const info = verification.registrationInfo;

  // pin the server's rpID to whatever the first-ever passkey was registered under
  if (!pinnedRpId(db)) setSetting(db, "rp_id_at_setup", rp.rpId);

  let userId: number;
  const tx = db.transaction(() => {
    if (intent.userId) {
      userId = intent.userId;
    } else {
      const displayName = (intent.displayName ?? "").trim() || "user";
      const res = db.query("INSERT INTO users (display_name, user_handle) VALUES (?, ?)").run(displayName, userHandle);
      userId = Number(res.lastInsertRowid);
    }
    db.query(
      "INSERT INTO passkey_credentials (id, user_id, name, public_key, counter, transports, device_type, backed_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      info.credential.id,
      userId,
      name,
      info.credential.publicKey,
      info.credential.counter,
      JSON.stringify(info.credential.transports ?? []),
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
    );
  });
  tx();
  return { credentialId: info.credential.id, userId: userId! };
}

/** Start an authentication ceremony (discoverable credentials → one-tap). */
export async function startAuthentication(db: Database, rp: RelyingParty) {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    userVerification: "required",
    allowCredentials: [],
  });
  const challengeId = storeChallenge(db, "authentication", options.challenge);
  return { options, challengeId };
}

export async function finishAuthentication(
  db: Database,
  rp: RelyingParty,
  body: AuthenticationResponseJSON,
  challengeId: string | undefined,
): Promise<{ userId: number } | { error: string }> {
  const pinErr = checkPin(db, rp);
  if (pinErr) return pinErr;
  const challenge = consumeChallenge(db, challengeId, "authentication");
  if (!challenge) return { error: "Challenge expired or missing — reload the page and try again." };
  const cred = db.query<PasskeyRow, [string]>("SELECT * FROM passkey_credentials WHERE id = ?").get(body.id);
  if (!cred) return { error: "Unknown passkey. Register first at /register." };
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(cred.public_key),
        counter: cred.counter,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
    });
  } catch (err) {
    return { error: `Passkey verification failed: ${err instanceof Error ? err.message : err}` };
  }
  if (!verification.verified) return { error: "Passkey verification failed." };
  db.query("UPDATE passkey_credentials SET counter = ?, last_used_at = unixepoch() WHERE id = ?").run(
    verification.authenticationInfo.newCounter,
    cred.id,
  );
  return { userId: cred.user_id };
}

/** Delete a passkey, only if it belongs to `userId` and is not their last one. */
export function deletePasskey(db: Database, userId: number, id: string): { ok: true } | { error: string } {
  const owned = db.query<{ id: string }, [string, number]>("SELECT id FROM passkey_credentials WHERE id = ? AND user_id = ?").get(id, userId);
  if (!owned) return { error: "Passkey not found." };
  const count = db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = ?").get(userId)!.n;
  if (count <= 1) {
    return { error: "Cannot delete your last passkey — you would be locked out. Add another passkey first." };
  }
  db.query("DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?").run(id, userId);
  return { ok: true };
}

export function renamePasskey(db: Database, userId: number, id: string, name: string) {
  db.query("UPDATE passkey_credentials SET name = ? WHERE id = ? AND user_id = ?").run(name, id, userId);
}
