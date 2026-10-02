/**
 * Audit log writer (contract `AuditEntry`, spec 8.8): one row per changed entity row, in the SAME transaction as the
 * change; `action` = operationId, `diff` = { apiField: [before, after] } over the changed fields only, API formats,
 * secrets (password, TOTP, tokens, hashes) as "***" on both sides; creation → before = null for every filled field.
 * `ip` and `request_id` come from the request context. The reading side is listAuditLog (Task 4).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Request } from 'express';
import { currentIp, currentRequestId } from '../../context.js';
import type { DB } from '../../db/types.generated.js';
import { dayAfter, QueryReader } from '../../http/params.js';
import { publicFileUrl } from '../../infra/file-urls.js';

export type AuditEntityType =
  | 'organization'
  | 'user'
  | 'field'
  | 'treatment'
  | 'batch'
  | 'waybill'
  | 'labTest'
  | 'recall'
  | 'recallTask'
  | 'complaint'
  | 'product'
  | 'substance'
  | 'indicator'
  | 'norm'
  | 'region'
  | 'file'
  | 'batchDocument';

export const SECRET = '***';

export type AuditDiff = Record<string, [unknown, unknown]>;

export interface AuditEntry {
  /** The acting user; null — system, seed, anonymous buyer. */
  actorId: string | null;
  /** operationId (or `system.<job>`). */
  action: string;
  entityType: AuditEntityType;
  entityId: string | null;
  diff: AuditDiff;
}

/**
 * `{field: [before, after]}` over the fields whose values differ (JSON equality); `before` = null → a creation: every
 * non-null field of `after` with null before. Values must already be in API format.
 */
export function auditDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): AuditDiff {
  const out: AuditDiff = {};
  for (const [k, v] of Object.entries(after)) {
    const b = before ? (before[k] ?? null) : null;
    if (before === null && (v === null || v === undefined)) continue;
    if (JSON.stringify(b) !== JSON.stringify(v ?? null)) out[k] = [b, v ?? null];
  }
  return out;
}

/** A hard delete: every non-null field of the removed row → [before, null] (the mirror of a creation). */
export function auditRemoval(before: Record<string, unknown>): AuditDiff {
  const out: AuditDiff = {};
  for (const [k, v] of Object.entries(before)) if (v !== null && v !== undefined) out[k] = [v, null];
  return out;
}

export async function record(tx: Transaction<DB>, e: AuditEntry): Promise<void> {
  await tx
    .insertInto('audit_log')
    .values({
      actor_id: e.actorId,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId,
      diff: JSON.stringify(e.diff),
      ip: currentIp(),
      backend: 'express',
      request_id: currentRequestId(),
    })
    .execute();
}

export const auditService = { record };

// ── reading (listAuditLog) ────────────────────────────────────────────────────────────────────────────────────────

export const AUDIT_ENTITY_TYPES: readonly AuditEntityType[] = [
  'organization',
  'user',
  'field',
  'treatment',
  'batch',
  'waybill',
  'labTest',
  'recall',
  'recallTask',
  'complaint',
  'product',
  'substance',
  'indicator',
  'norm',
  'region',
  'file',
  'batchDocument',
];
const AUDIT_BACKENDS = ['express', 'django', 'laravel', 'seed', 'system'] as const;
const AUDIT_SORT = { fields: ['createdAt'], default: 'createdAt,desc' } as const;

/** The contract's `AuditEntry`. */
export interface AuditEntryView {
  id: number;
  actor: {
    id: string;
    fullName: string;
    organization: { id: string; name: string; type: string; logoUrl: string | null };
  } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  diff: Record<string, unknown>;
  ip: string | null;
  backend: string;
  requestId: string | null;
  createdAt: string;
}

/**
 * listAuditLog (audit.yaml): every row for ADMIN and INSPECTOR alike; filters actorId, entityType, entityId, action
 * (exact), backend, from/to (UTC dates of createdAt, inclusive); sorted by createdAt, ties by id ascending.
 */
export async function listAuditLog(
  db: Kysely<DB>,
  query: Request['query'],
): Promise<{ items: AuditEntryView[]; page: number; size: number; total: number }> {
  const q = new QueryReader(query);
  const { page, size, sort } = q.page(AUDIT_SORT);
  const actorId = q.uuid('actorId');
  const entityType = q.enumOf('entityType', AUDIT_ENTITY_TYPES);
  const entityId = q.uuid('entityId');
  const action = q.text('action', 64);
  const backend = q.enumOf('backend', AUDIT_BACKENDS);
  const { from, to } = q.dateRange();
  q.done();

  let base = db.selectFrom('audit_log as a');
  if (actorId) base = base.where('a.actor_id', '=', actorId);
  if (entityType) base = base.where('a.entity_type', '=', entityType);
  if (entityId) base = base.where('a.entity_id', '=', entityId);
  if (action !== undefined) base = base.where('a.action', '=', action);
  if (backend) base = base.where('a.backend', '=', backend);
  if (from) base = base.where('a.created_at', '>=', new Date(`${from}T00:00:00Z`));
  if (to) base = base.where('a.created_at', '<', dayAfter(to));

  const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [{ total: string }];
  const rows = await base
    .leftJoin('users as u', 'u.id', 'a.actor_id')
    .leftJoin('organizations as o', 'o.id', 'u.organization_id')
    .select([
      'a.id',
      'a.actor_id',
      'a.action',
      'a.entity_type',
      'a.entity_id',
      'a.diff',
      sql<string | null>`host(a.ip)`.as('ip'),
      'a.backend',
      'a.request_id',
      'a.created_at',
      'u.full_name',
      'o.id as org_id',
      'o.name as org_name',
      'o.type as org_type',
      'o.logo_file_id',
    ])
    .orderBy('a.created_at', sort.dir)
    .orderBy('a.id', 'asc')
    .limit(size)
    .offset((page - 1) * size)
    .execute();
  return {
    items: rows.map((r) => ({
      id: Number(r.id),
      actor:
        r.actor_id && r.full_name !== null && r.org_id !== null
          ? {
              id: r.actor_id,
              fullName: r.full_name,
              organization: {
                id: r.org_id,
                name: r.org_name!,
                type: r.org_type!,
                logoUrl: r.logo_file_id ? publicFileUrl(r.logo_file_id) : null,
              },
            }
          : null,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      diff: (typeof r.diff === 'string' ? JSON.parse(r.diff) : r.diff) as Record<string, unknown>,
      ip: r.ip,
      backend: r.backend,
      requestId: r.request_id,
      createdAt: new Date(r.created_at as unknown as Date).toISOString(),
    })),
    page,
    size,
    total: Number(total),
  };
}
