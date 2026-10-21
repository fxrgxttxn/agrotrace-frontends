/**
 * Access tokens (contract `AccessToken`): JWT HS256 with the shared JWT_SECRET, 15 minutes, claims `sub`, `org`,
 * `roles`, `org_admin`, `exp`, `iat`, `jti`. A token issued by any backend is accepted by any other.
 */
import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT, errors } from 'jose';

export const ACCESS_TTL_SEC = 900;

export type RoleCode = 'FARMER' | 'PROCESSOR' | 'LAB' | 'RETAILER' | 'INSPECTOR' | 'ADMIN';
const ROLES = new Set<string>(['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN']);

/** The authenticated principal of a request (from the verified claims only — no database read). */
export interface Principal {
  userId: string;
  orgId: string;
  roles: RoleCode[];
  orgAdmin: boolean;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function issueAccessToken(secret: string, p: Principal, now = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ org: p.orgId, roles: p.roles, org_admin: p.orgAdmin })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(p.userId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TTL_SEC)
    .setJti(randomUUID())
    .sign(key(secret));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The principal of a valid token; null for anything else. Claim types per the contract (`AccessToken`, P12): `sub`
 * and `org` UUIDs, `roles` a non-empty array of RoleCode, `org_admin` boolean, `exp`/`iat` integers, `jti` string;
 * HS256 only; an unknown `crit` header parameter is rejected (jose).
 */
export async function verifyAccessToken(secret: string, token: string): Promise<Principal | null> {
  return (await verifyAccessTokenExp(secret, token))?.principal ?? null;
}

/** Like `verifyAccessToken`, with the token's `exp` (seconds) — the SSE stream ends with `reauth` at it. */
export async function verifyAccessTokenExp(
  secret: string,
  token: string,
): Promise<{ principal: Principal; exp: number } | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'jti'],
    });
    const { sub, org, roles, org_admin: orgAdmin, exp, iat, jti } = payload;
    if (typeof sub !== 'string' || !UUID.test(sub) || typeof org !== 'string' || !UUID.test(org)) return null;
    if (typeof orgAdmin !== 'boolean' || typeof jti !== 'string') return null;
    if (!Number.isInteger(exp) || !Number.isInteger(iat)) return null;
    if (
      !Array.isArray(roles) ||
      roles.length === 0 ||
      !roles.every((r) => typeof r === 'string' && ROLES.has(r))
    )
      return null;
    return {
      principal: { userId: sub, orgId: org, roles: roles as RoleCode[], orgAdmin },
      exp: exp as number,
    };
  } catch (err) {
    if (err instanceof errors.JOSEError || err instanceof TypeError) return null;
    throw err;
  }
}
