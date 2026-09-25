/**
 * Refresh tokens (R32, R40): an opaque token (32 random bytes, base64url) in the `at_refresh` cookie, stored as its
 * sha256 in `refresh_tokens`, 14 days. Every refresh rotates: the presented row gets `revoked_at` and `replaced_by` =
 * the new row, so the rows of one session form a chain. A row revoked with `replaced_by` = null was revoked by logout,
 * a password reset, a 403 on refresh or a chain revocation — never by rotation.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../db/types.generated.js';
import { withTx } from '../../db/tx.js';
import { newOpaqueToken, sha256hex } from '../../security/tokens.js';

export const REFRESH_TTL_SEC = 14 * 24 * 3600;
/** R32: a token rotated at most this long ago is a race between tabs, not a reuse. */
export const ROTATION_GRACE_MS = 10_000;

const COOKIE_ATTRS = 'Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict';
export const setRefreshCookie = (token: string): string =>
  `at_refresh=${token}; Max-Age=${REFRESH_TTL_SEC}; ${COOKIE_ATTRS}`;
export const CLEAR_REFRESH_COOKIE = `at_refresh=; Max-Age=0; ${COOKIE_ATTRS}`;

/** The `at_refresh` value of a Cookie header (the first one), or null. */
export function refreshCookieOf(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === 'at_refresh') {
      const v = part.slice(eq + 1).trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

/** Inserts a new refresh token row for `userId`; returns the token (only its hash is stored). */
export async function createRefreshToken(
  db: Kysely<DB> | Transaction<DB>,
  userId: string,
  now = new Date(),
): Promise<{ id: string; token: string }> {
  const token = newOpaqueToken();
  const row = await db
    .insertInto('refresh_tokens')
    .values({
      user_id: userId,
      token_hash: sha256hex(token),
      expires_at: new Date(now.getTime() + REFRESH_TTL_SEC * 1000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, token };
}

/**
 * R40: revokes the rotation chain of `id` — every row linked to it through `replaced_by`, its ancestors and its
 * descendants (the active one included); other sessions of the user are untouched. The lineage rows are locked
 * (`FOR UPDATE`, in id order) before the revocation, and the walk is repeated until it finds no new row: a rotation
 * of the active descendant running concurrently either commits first (its new row joins the lineage on the next
 * walk) or waits for this transaction and then finds its token revoked.
 */
const lineage = (id: string) => sql<{ id: string }>`
  SELECT id FROM refresh_tokens WHERE id IN (
    WITH RECURSIVE down(id, replaced_by) AS (
      SELECT id, replaced_by FROM refresh_tokens WHERE id = ${id}
      UNION
      SELECT r.id, r.replaced_by FROM refresh_tokens r JOIN down d ON r.id = d.replaced_by
    ), up(id) AS (
      SELECT id FROM refresh_tokens WHERE id = ${id}
      UNION
      SELECT r.id FROM refresh_tokens r JOIN up u ON r.replaced_by = u.id
    )
    SELECT id FROM down UNION SELECT id FROM up
  ) ORDER BY id FOR UPDATE`;

async function revokeChain(tx: Transaction<DB>, id: string, now: Date): Promise<void> {
  let ids = new Set<string>();
  for (;;) {
    const locked = new Set((await lineage(id).execute(tx)).rows.map((r) => r.id));
    if (locked.size === ids.size) break;
    ids = locked;
  }
  await tx
    .updateTable('refresh_tokens')
    .set({ revoked_at: now })
    .where('id', 'in', [...ids])
    .where('revoked_at', 'is', null)
    .execute();
}

export type RefreshOutcome =
  | { kind: 'rotated'; userId: string; token: string }
  /** 401 TOKEN_EXPIRED; `clearCookie` false only in the rotation race (R32). */
  | { kind: 'expired'; clearCookie: boolean }
  | { kind: 'forbidden'; reason: 'USER_BLOCKED' | 'ORGANIZATION_NOT_ACTIVE' };

/**
 * refreshToken (contract): the presented row is locked (`FOR UPDATE`), so two parallel refreshes with one token
 * rotate once — the second sees the row revoked by rotation just now (grace → 401 without cookie deletion).
 */
export function rotateRefreshToken(db: Kysely<DB>, token: string | null): Promise<RefreshOutcome> {
  if (token === null || !/^[A-Za-z0-9_-]{16,256}$/.test(token))
    return Promise.resolve({ kind: 'expired', clearCookie: true });
  const hash = sha256hex(token);
  return withTx(db, async (tx): Promise<RefreshOutcome> => {
    const now = new Date();
    const row = await tx
      .selectFrom('refresh_tokens')
      .select(['id', 'user_id', 'expires_at', 'revoked_at', 'replaced_by'])
      .where('token_hash', '=', hash)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { kind: 'expired', clearCookie: true };
    if (row.revoked_at) {
      // Revoked by logout / reset / 403 / an earlier chain revocation: nothing more to revoke (R40).
      if (row.replaced_by === null) return { kind: 'expired', clearCookie: true };
      if (now.getTime() - row.revoked_at.getTime() <= ROTATION_GRACE_MS)
        return { kind: 'expired', clearCookie: false };
      await revokeChain(tx, row.id, now);
      return { kind: 'expired', clearCookie: true };
    }
    if (row.expires_at.getTime() <= now.getTime()) return { kind: 'expired', clearCookie: true };

    const u = await tx
      .selectFrom('users as u')
      .innerJoin('organizations as o', 'o.id', 'u.organization_id')
      .select(['u.status', 'u.deleted_at', 'o.status as org_status', 'o.deleted_at as org_deleted_at'])
      .where('u.id', '=', row.user_id)
      .executeTakeFirst();
    const revoke = () =>
      tx.updateTable('refresh_tokens').set({ revoked_at: now }).where('id', '=', row.id).execute();
    if (!u || u.deleted_at !== null || u.status === 'INVITED') {
      await revoke();
      return { kind: 'expired', clearCookie: true };
    }
    if (u.status === 'BLOCKED') {
      await revoke();
      return { kind: 'forbidden', reason: 'USER_BLOCKED' };
    }
    if (u.org_status !== 'ACTIVE' || u.org_deleted_at !== null) {
      await revoke();
      return { kind: 'forbidden', reason: 'ORGANIZATION_NOT_ACTIVE' };
    }
    const next = await createRefreshToken(tx, row.user_id, now);
    await tx
      .updateTable('refresh_tokens')
      .set({ revoked_at: now, replaced_by: next.id })
      .where('id', '=', row.id)
      .execute();
    return { kind: 'rotated', userId: row.user_id, token: next.token };
  });
}

/** logout: revokes the presented token if it is live (idempotent). */
export async function revokeRefreshToken(db: Kysely<DB>, token: string | null): Promise<void> {
  if (token === null || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) return;
  await db
    .updateTable('refresh_tokens')
    .set({ revoked_at: new Date() })
    .where('token_hash', '=', sha256hex(token))
    .where('revoked_at', 'is', null)
    .execute();
}

/** Every live refresh token of the user (password reset). */
export async function revokeAllRefreshTokens(
  tx: Transaction<DB>,
  userId: string,
  now = new Date(),
): Promise<void> {
  await tx
    .updateTable('refresh_tokens')
    .set({ revoked_at: now })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
