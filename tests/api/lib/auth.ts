/**
 * Sign-in as a demo user of the seed (db/seed/data/users.json, docs/demo-accounts.md) — the data files, never the
 * backend. `./at.sh reset` (or `seed`) must have loaded the dev DB the backend uses.
 */
import users from '../../../db/seed/data/users.json' with { type: 'json' };
import { DEMO_PASSWORD } from '../../../db/seed/src/data.js';
import { ApiClient } from './client.js';
import { expectContract } from './contract.js';

export type Role = 'FARMER' | 'PROCESSOR' | 'LAB' | 'RETAILER' | 'INSPECTOR' | 'ADMIN';

export interface DemoUser {
  key: string;
  org: string;
  email: string;
  fullName: string;
  roles: Role[];
  isOrgAdmin: boolean;
}

export const demoUsers = users as unknown as DemoUser[];

/**
 * The first demo user (seed order) with `role`; `head: true` — an organization head, `head: false` — an employee,
 * omitted — either. `key` picks one user by its seed key instead.
 */
export function demoUser(role: Role, opts: { head?: boolean; key?: string } = {}): DemoUser {
  const u = demoUsers.find(
    (x) =>
      x.roles.includes(role) &&
      (opts.head === undefined || x.isOrgAdmin === opts.head) &&
      (opts.key === undefined || x.key === opts.key),
  );
  if (!u) throw new Error(`no demo user with role ${role} ${JSON.stringify(opts)}`);
  return u;
}

/** Signs in (POST /auth/login) and returns a client carrying the access token and the `at_refresh` cookie. */
export async function loginAs(role: Role, opts: { head?: boolean; key?: string } = {}): Promise<ApiClient> {
  const user = demoUser(role, opts);
  const client = new ApiClient();
  const res = await client.post('/auth/login', { email: user.email, password: DEMO_PASSWORD });
  await expectContract(res, 'login');
  if (res.status !== 200 || res.body?.twoFactorRequired !== false)
    throw new Error(`login as ${user.email} failed: ${res.status} ${res.text}`);
  client.accessToken = res.body.accessToken as string;
  return client;
}
