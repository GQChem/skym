import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "./db.js";

/**
 * Tokens are stored as SHA-256 hashes. A database leak then yields nothing that
 * can be replayed against the API — the plaintext exists only in the agent's
 * config file and the user's cookie.
 */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const newToken = (): string => randomBytes(32).toString("base64url");

/** Constant-time compare, so a wrong token leaks nothing through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface Principal {
  userId: string;
  /** How they authenticated; agents may not touch account settings. */
  via: "session" | "agent";
}

const SESSION_DAYS = 30;

export async function createSession(pool: Pool, userId: string): Promise<string> {
  const token = newToken();
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [userId, hashToken(token), String(SESSION_DAYS)],
  );
  return token;
}

export async function resolveSession(pool: Pool, token: string): Promise<Principal | null> {
  const r = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()",
    [hashToken(token)],
  );
  const row = r.rows[0];
  return row ? { userId: row.user_id, via: "session" } : null;
}

export async function resolveAgentToken(pool: Pool, token: string): Promise<Principal | null> {
  const r = await pool.query<{ id: string; user_id: string }>(
    "SELECT id, user_id FROM agent_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Best-effort: a failed touch must not fail the request.
  pool
    .query("UPDATE agent_tokens SET last_used_at = now() WHERE id = $1", [row.id])
    .catch(() => {});
  return { userId: row.user_id, via: "agent" };
}

/**
 * Finds or creates the user behind a provider login.
 *
 * Linking is on VERIFIED email only. An unverified address must never join an
 * existing account: anyone could sign up at a provider claiming someone else's
 * address and inherit their charts.
 */
export async function upsertIdentity(
  pool: Pool,
  provider: "google" | "github",
  providerUserId: string,
  email: string,
  emailVerified: boolean,
  profile: { name?: string; avatarUrl?: string },
): Promise<string> {
  const existing = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM identities WHERE provider = $1 AND provider_user_id = $2",
    [provider, providerUserId],
  );
  const found = existing.rows[0];
  if (found) return found.user_id;

  let userId: string | undefined;
  if (emailVerified) {
    const byEmail = await pool.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1)", [
      email,
    ]);
    userId = byEmail.rows[0]?.id;
  }

  if (!userId) {
    // An unverified email still needs a unique row, so keep it distinct.
    const stored = emailVerified ? email : `${provider}:${providerUserId}:${email}`;
    const created = await pool.query<{ id: string }>(
      "INSERT INTO users (email, name, avatar_url) VALUES ($1, $2, $3) RETURNING id",
      [stored, profile.name ?? null, profile.avatarUrl ?? null],
    );
    userId = created.rows[0]!.id;
  }

  await pool.query(
    `INSERT INTO identities (user_id, provider, provider_user_id, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_user_id) DO NOTHING`,
    [userId, provider, providerUserId, email],
  );
  return userId;
}

// --- device-code pairing ---

/** No look-alike characters: this is read off a terminal and typed by hand. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function userCode(): string {
  const pick = () =>
    Array.from(randomBytes(4))
      .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
      .join("");
  return `${pick()}-${pick()}`;
}

export const PAIRING_TTL_MINUTES = 15;

export async function startPairing(pool: Pool): Promise<{ deviceCode: string; userCode: string; expiresIn: number }> {
  const deviceCode = randomUUID();
  const code = userCode();
  await pool.query(
    `INSERT INTO pairings (device_code, user_code, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [deviceCode, code, String(PAIRING_TTL_MINUTES)],
  );
  return { deviceCode, userCode: code, expiresIn: PAIRING_TTL_MINUTES * 60 };
}

export async function approvePairing(pool: Pool, code: string, userId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE pairings SET user_id = $1, approved_at = now()
     WHERE upper(user_code) = upper($2) AND expires_at > now() AND approved_at IS NULL`,
    [userId, code],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The agent polls with its device code. Returns the token exactly once —
 * the pairing is consumed, so a leaked device code cannot be redeemed twice.
 */
export async function redeemPairing(
  pool: Pool,
  deviceCode: string,
): Promise<{ status: "pending" | "expired" | "ready"; token?: string }> {
  const r = await pool.query<{ user_id: string | null; approved_at: Date | null; expired: boolean }>(
    "SELECT user_id, approved_at, (expires_at <= now()) AS expired FROM pairings WHERE device_code = $1",
    [deviceCode],
  );
  const row = r.rows[0];
  if (!row) return { status: "expired" };
  if (row.expired) return { status: "expired" };
  if (!row.approved_at || !row.user_id) return { status: "pending" };

  const token = newToken();
  await pool.query("INSERT INTO agent_tokens (user_id, token_hash, label) VALUES ($1, $2, $3)", [
    row.user_id,
    hashToken(token),
    "skym-flow agent",
  ]);
  await pool.query("DELETE FROM pairings WHERE device_code = $1", [deviceCode]);
  return { status: "ready", token };
}

/** Membership check every chart route runs; there is no implicit access. */
export async function canAccessChart(pool: Pool, userId: string, chartId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1
       FROM charts c
       JOIN projects p ON p.id = c.project_id
       LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
      WHERE c.id = $2 AND (p.owner_id = $1 OR m.user_id IS NOT NULL)`,
    [userId, chartId],
  );
  return (r.rowCount ?? 0) > 0;
}
