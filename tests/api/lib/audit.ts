/**
 * The audit log through the API (listAuditLog, GET /audit-log, read by ADMIN and INSPECTOR): tests assert the rows an
 * operation wrote without touching the database.
 */
import { expect } from 'vitest';
import { loginAs } from './auth.js';
import type { ApiClient } from './client.js';
import { expectContract } from './contract.js';

export interface AuditEntry {
  id: number;
  actor: { id: string; fullName: string; organization: { id: string; name: string } } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  diff: Record<string, [unknown, unknown]>;
  ip: string | null;
  backend: string;
  requestId: string | null;
  createdAt: string;
}

let reader: Promise<ApiClient> | null = null;

/** A signed-in platform ADMIN, shared by the calls of one test file. */
function auditReader(): Promise<ApiClient> {
  reader ??= loginAs('ADMIN', { head: true });
  return reader;
}

/**
 * Every row matching `filters` (listAuditLog query parameters), oldest first (`sort=createdAt,asc`; rows of one
 * transaction share `createdAt` and follow by id).
 */
export async function auditEntries(
  filters: Record<string, string | undefined>,
  client?: ApiClient,
): Promise<AuditEntry[]> {
  const c = client ?? (await auditReader());
  const out: AuditEntry[] = [];
  for (let page = 1; ; page++) {
    const res = await c.get('/audit-log', { query: { ...filters, sort: 'createdAt,asc', size: 100, page } });
    await expectContract(res, 'listAuditLog');
    expect(res.status, res.text).toBe(200);
    out.push(...(res.body.items as AuditEntry[]));
    if (out.length >= res.body.total || res.body.items.length === 0) return out;
  }
}

/** The diffs of `action` on one entity, oldest first. */
export async function auditDiffs(
  action: string,
  entityId: string,
): Promise<{ entityType: string; diff: AuditEntry['diff'] }[]> {
  const rows = await auditEntries({ action, entityId });
  return rows.map((r) => ({ entityType: r.entityType, diff: r.diff }));
}
