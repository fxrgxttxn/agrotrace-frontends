/**
 * Cross-backend scenario (spec 15.2 «Кросс-backend»; contract info.description: a token, file or notification created
 * by one implementation is accepted by any other): a session started on backend A continues on backend B — B accepts
 * A's access token (shared JWT_SECRET, HS256) and rotates A's refresh token (shared `refresh_tokens`), and A accepts
 * the token B issued. Every response names the backend that answered (`X-Backend`).
 *
 * Runs with the default express×express pair on main; each port runs it as `./at cross:test <a> <b>` in both orders
 * (the further scenarios are in interop.test.ts).
 */
import { describe, expect, it } from 'vitest';
import users from '../../db/seed/data/users.json' with { type: 'json' };
import { DEMO_PASSWORD } from '../../db/seed/src/data.js';
import { A, B, SAME_BACKEND } from './lib/backends.js';
import { call, type Session } from './lib/http.js';

const farmer = (users as { email: string; roles: string[]; isOrgAdmin: boolean }[]).find(
  (u) => u.roles.includes('FARMER') && u.isOrgAdmin,
)!;

describe(`session across backends: ${A.backend} → ${B.backend}${SAME_BACKEND ? ' (same-backend pair)' : ''}`, () => {
  it('B accepts the access token of A, rotates its refresh token; A accepts the token from B', async () => {
    const s: Session = { accessToken: null, refresh: null };
    const login = await call(A, s, 'POST', '/auth/login', { email: farmer.email, password: DEMO_PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.headers.get('x-backend')).toBe(A.backend);
    s.accessToken = login.body!.accessToken as string;
    const userId = (login.body!.user as { id: string }).id;
    expect(s.refresh, 'A set the at_refresh cookie').not.toBeNull();

    const meOnB = await call(B, s, 'GET', '/me');
    expect(meOnB.status, JSON.stringify(meOnB.body)).toBe(200);
    expect(meOnB.headers.get('x-backend')).toBe(B.backend);
    expect(meOnB.body!.id).toBe(userId);

    const rotated = await call(B, { accessToken: null, refresh: s.refresh }, 'POST', '/auth/refresh');
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.headers.get('x-backend')).toBe(B.backend);
    const meOnA = await call(
      A,
      { accessToken: rotated.body!.accessToken as string, refresh: null },
      'GET',
      '/me',
    );
    expect(meOnA.status).toBe(200);
    expect(meOnA.headers.get('x-backend')).toBe(A.backend);
    expect(meOnA.body!.id).toBe(userId);
  });
});
