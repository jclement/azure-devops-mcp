import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { openPat, patLast4, sealPat } from "../crypto.ts";

/** Public view of a connection — never includes PAT material. */
export interface ConnectionRow {
  id: string;
  user_id: number;
  slug: string;
  org: string;
  email_label: string;
  pat_last4: string | null;
  domains: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

interface SecretRow extends ConnectionRow {
  pat_ciphertext: Uint8Array;
  pat_nonce: Uint8Array;
  pat_tag: Uint8Array;
}

const PUBLIC_COLS =
  "id, user_id, slug, org, email_label, pat_last4, domains, created_at, updated_at, last_used_at";

export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export interface NewConnection {
  slug?: string;
  org: string;
  pat: string;
  emailLabel?: string;
  domains?: string | null;
}

export class ConnectionError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// Azure DevOps org names: start alphanumeric, then alphanumerics/hyphens. We
// validate at the write boundary so the value can never be mistaken for a CLI
// flag when it becomes a positional argv element of the upstream child.
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
// Toolset/domain filter: comma-separated bare identifiers only.
const DOMAINS_RE = /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/;

export function createConnection(db: Database, key: Buffer, userId: number, input: NewConnection): ConnectionRow {
  const org = input.org.trim();
  if (!org) throw new ConnectionError("INVALID_ORG", "Organization is required.");
  if (!ORG_RE.test(org)) {
    throw new ConnectionError("INVALID_ORG", "Organization must be alphanumeric/hyphens and start with a letter or digit.");
  }
  const pat = input.pat.trim();
  if (!pat) throw new ConnectionError("INVALID_PAT", "Personal Access Token is required.");
  const domains = input.domains?.trim() || null;
  if (domains && !DOMAINS_RE.test(domains)) {
    throw new ConnectionError("INVALID_DOMAINS", "Toolset filter must be comma-separated identifiers (letters, digits, _ or -).");
  }
  const slug = slugify(input.slug?.trim() || org);
  if (!slug) throw new ConnectionError("INVALID_SLUG", "Could not derive a slug — provide one explicitly.");

  const exists = db
    .query<{ id: string }, [number, string]>("SELECT id FROM connections WHERE user_id = ? AND slug = ?")
    .get(userId, slug);
  if (exists) throw new ConnectionError("DUPLICATE_SLUG", `You already have a connection named '${slug}'.`);

  const sealed = sealPat(key, pat);
  const id = randomBytes(12).toString("base64url");
  db.query(
    `INSERT INTO connections (id, user_id, slug, org, email_label, pat_ciphertext, pat_nonce, pat_tag, pat_last4, domains)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    slug,
    org,
    input.emailLabel?.trim() || "mcp@local",
    sealed.ciphertext,
    sealed.nonce,
    sealed.tag,
    patLast4(pat),
    domains,
  );
  return getConnection(db, userId, id)!;
}

export function listConnections(db: Database, userId: number): ConnectionRow[] {
  return db
    .query<ConnectionRow, [number]>(`SELECT ${PUBLIC_COLS} FROM connections WHERE user_id = ? ORDER BY created_at`)
    .all(userId);
}

/** Fetch one connection, scoped to the owning user. */
export function getConnection(db: Database, userId: number, id: string): ConnectionRow | null {
  return db
    .query<ConnectionRow, [string, number]>(`SELECT ${PUBLIC_COLS} FROM connections WHERE id = ? AND user_id = ?`)
    .get(id, userId);
}

export function getConnectionBySlug(db: Database, userId: number, slug: string): ConnectionRow | null {
  return db
    .query<ConnectionRow, [string, number]>(`SELECT ${PUBLIC_COLS} FROM connections WHERE slug = ? AND user_id = ?`)
    .get(slug, userId);
}

/** Decrypt the PAT for a connection. Caller must already have scoped to the user. */
export function openConnectionPat(db: Database, key: Buffer, userId: number, id: string): string | null {
  const row = db
    .query<SecretRow, [string, number]>("SELECT * FROM connections WHERE id = ? AND user_id = ?")
    .get(id, userId);
  if (!row) return null;
  return openPat(key, {
    ciphertext: Buffer.from(row.pat_ciphertext),
    nonce: Buffer.from(row.pat_nonce),
    tag: Buffer.from(row.pat_tag),
  });
}

/** Rotate the PAT; bumps updated_at so the supervisor recycles the child. */
export function updateConnectionPat(db: Database, key: Buffer, userId: number, id: string, pat: string): boolean {
  const trimmed = pat.trim();
  if (!trimmed) throw new ConnectionError("INVALID_PAT", "Personal Access Token is required.");
  const sealed = sealPat(key, trimmed);
  const res = db
    .query(
      "UPDATE connections SET pat_ciphertext = ?, pat_nonce = ?, pat_tag = ?, pat_last4 = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?",
    )
    .run(sealed.ciphertext, sealed.nonce, sealed.tag, patLast4(trimmed), id, userId);
  return res.changes > 0;
}

export function deleteConnection(db: Database, userId: number, id: string): boolean {
  return db.query("DELETE FROM connections WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

export function touchConnection(db: Database, id: string) {
  db.query("UPDATE connections SET last_used_at = unixepoch() WHERE id = ?").run(id);
}
