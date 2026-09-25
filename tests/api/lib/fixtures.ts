/**
 * Data factories through the API: suites that change data create their own organizations and users so they stay
 * independent of each other and re-runnable after `./at.sh reset`.
 */
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { api, ApiClient } from './client.js';
import { expectContract } from './contract.js';
import { fixtureWrite } from './db.js';

export type RegistrableType = 'FARM' | 'PROCESSOR' | 'LAB' | 'RETAILER' | 'AUTHORITY';

export const ROLE_OF_TYPE = {
  FARM: 'FARMER',
  PROCESSOR: 'PROCESSOR',
  LAB: 'LAB',
  RETAILER: 'RETAILER',
  AUTHORITY: 'INSPECTOR',
} as const;

const INN_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const control = (d: number[], w: number[]) => (w.reduce((s, k, i) => s + k * d[i]!, 0) % 11) % 10;

/** A random INN with a valid FNS checksum (R66), 10 digits (organization) or 12 (individual entrepreneur). */
export function randomInn(length: 10 | 12 = 10): string {
  const d = [...randomBytes(length)].map((b) => b % 10);
  if (length === 10) d[9] = control(d, INN_10);
  else {
    d[10] = control(d, INN_11);
    d[11] = control(d, INN_12);
  }
  return d.join('');
}

/** The same INN with its last digit changed — the checksum no longer matches. */
export const breakChecksum = (inn: string): string =>
  inn.slice(0, -1) + String((Number(inn.at(-1)) + 1) % 10);

let seq = 0;
/** A unique lower-case email (`prefix.<unique>@agrotrace.test`). */
export function uniqueEmail(prefix = 'user'): string {
  seq += 1;
  return `${prefix}.${Date.now().toString(36)}${seq}${randomBytes(3).toString('hex')}@agrotrace.test`;
}

export const PASSWORD = 'Ozimaya-2026!';

export interface RegisteredOrg {
  organizationId: string;
  status: 'PENDING' | 'MANUAL_CHECK';
  inn: string;
  email: string;
  password: string;
  fullName: string;
}

/** registerOrganization with a fresh INN and email; asserts 201. */
export async function registerOrg(
  type: RegistrableType = 'FARM',
  over: { email?: string; password?: string; inn?: string; name?: string } = {},
): Promise<RegisteredOrg> {
  const body = {
    inn: over.inn ?? randomInn(),
    type,
    name: over.name ?? `Тестовая организация ${randomBytes(3).toString('hex')}`,
    regionCode: '33',
    admin: {
      email: over.email ?? uniqueEmail(type.toLowerCase()),
      fullName: 'Тестов Тест Тестович',
      password: over.password ?? PASSWORD,
    },
  };
  const res = await api().post('/auth/register-organization', body);
  await expectContract(res, 'registerOrganization');
  expect(res.status, res.text).toBe(201);
  return {
    organizationId: res.body.organizationId,
    status: res.body.status,
    inn: body.inn,
    email: body.admin.email.toLowerCase(),
    password: body.admin.password,
    fullName: body.admin.fullName,
  };
}

/**
 * Makes a registered organization ACTIVE.
 * TODO(Task 4): replace with approveOrganization (POST /admin/organizations/{id}/approve as ADMIN) once it exists;
 * until then the state is set directly (lib/db.ts fixtureWrite).
 */
export async function activateOrg(organizationId: string): Promise<void> {
  await fixtureWrite(`UPDATE organizations SET status = 'ACTIVE' WHERE id = $1`, [organizationId]);
}

/** A new active organization of `type` and its head; `client` is anonymous (log in with `login`). */
export async function activeOrgHead(type: RegistrableType = 'FARM'): Promise<RegisteredOrg> {
  const org = await registerOrg(type);
  await activateOrg(org.organizationId);
  return org;
}

/** POST /auth/login on `client`; on 200 without TOTP stores the access token. */
export async function login(client: ApiClient, email: string, password: string) {
  const res = await client.post('/auth/login', { email, password });
  await expectContract(res, 'login');
  if (res.status === 200 && res.body.twoFactorRequired === false) client.accessToken = res.body.accessToken;
  return res;
}

/** A signed-in client of a fresh head of a new active organization of `type`. */
export async function freshHead(type: RegistrableType = 'FARM') {
  const org = await activeOrgHead(type);
  const client = api();
  const res = await login(client, org.email, org.password);
  expect(res.status, res.text).toBe(200);
  return { org, client, user: res.body.user as { id: string; roles: string[] } };
}
