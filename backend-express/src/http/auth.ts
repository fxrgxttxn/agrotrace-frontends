/**
 * Bearer authentication and role checks (contract `security: bearer`, `x-roles`, `x-org-admin`). The roles of an
 * operation are read from the contract itself (by operationId), so routes cannot drift from it. Order (contract
 * info.description): 401 → the `user` rate limit (R30: every Bearer-authenticated request counts) → 403 by role.
 * The principal comes from the verified JWT claims only; a blocked user's access token lives out its ≤ 15 minutes
 * (logout/refresh descriptions).
 */
import type { Request, RequestHandler, Response } from 'express';
import type { Container } from '../container.js';
import { operationById } from '../contract.js';
import { verifyAccessToken, type Principal } from '../security/jwt.js';
import { ah } from './async.js';
import { AppProblem } from './problem.js';
import { hitRateLimit } from './rate-limit.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/** The verified principal of `req`, or 401 UNAUTHORIZED. */
export async function authenticate(c: Container, req: Request): Promise<Principal> {
  const m = BEARER.exec(req.headers.authorization ?? '');
  const principal = m ? await verifyAccessToken(c.config.JWT_SECRET, m[1]!) : null;
  if (!principal) throw new AppProblem(401, 'UNAUTHORIZED');
  return principal;
}

/** The principal of a valid Bearer token, or null (no header, a malformed or invalid token) — never throws 401. */
export async function bearerPrincipal(c: Container, req: Request): Promise<Principal | null> {
  const m = BEARER.exec(req.headers.authorization ?? '');
  return m ? verifyAccessToken(c.config.JWT_SECRET, m[1]!) : null;
}

/**
 * Guard of a Bearer-secured operation: authenticates, counts the `user` limit, checks `x-roles` (`ANY` = any
 * authenticated role) and `x-org-admin` (roles other than ADMIN must be the head of their organization); the
 * principal is left in `res.locals.principal` (read it with `principalOf`).
 */
export function guard(c: Container, operationId: string): RequestHandler {
  if (!c.contract) throw new Error('guard(): the contract is not loaded');
  const op = operationById(c.contract.doc, operationId);
  const roles = (op['x-roles'] as string[] | undefined) ?? [];
  const orgAdmin = op['x-org-admin'] === true;
  if (roles.includes('PUBLIC')) throw new Error(`guard(): ${operationId} is public`);
  return ah(async (req, res, next) => {
    const principal = await authenticate(c, req);
    await hitRateLimit(c.redis, 'user', principal.userId, c.config.RATE_LIMIT_OVERRIDES);
    const roleOk = roles.includes('ANY') || principal.roles.some((r) => roles.includes(r));
    const adminOk = !orgAdmin || principal.roles.includes('ADMIN') || principal.orgAdmin;
    if (!roleOk || !adminOk) throw new AppProblem(403, 'FORBIDDEN');
    res.locals.principal = principal;
    next();
  });
}

export function principalOf(res: Response): Principal {
  const p = res.locals.principal as Principal | undefined;
  if (!p) throw new Error('principalOf(): the route has no guard()');
  return p;
}
