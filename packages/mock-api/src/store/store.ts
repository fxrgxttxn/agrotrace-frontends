import { hex, MOCK_NAMESPACE, randomBytes, uuidV5 } from '../lib/crypto.js';
import { iso } from '../lib/time.js';
import type { KvEntry, Sequences, TableName, Tables } from './types.js';

type Row = object;

type Undo = () => void;

export interface AuditRecord {
  action: string;
  actorId: string | null;
  entityType: string;
  entityId: string | null;
  diff: Record<string, [unknown, unknown]>;
  at?: string;
}

interface Operation {
  action: string;
  actorId: string | null;
  undo: Undo[];
  touched: Map<object, { type: string; before: Record<string, unknown> | null; id: string }>;
  audit: AuditRecord[];
  afterCommit: (() => void)[];
}

const SECRET_COLUMNS = new Set(['password', 'totp_secret', 'token']);
const AUDIT_SKIP = new Set(['id', 'created_at', 'updated_at', 'created_by', 'content', 'failed_logins']);

const camel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function auditView(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_') || AUDIT_SKIP.has(k)) continue;
    out[camel(k)] = SECRET_COLUMNS.has(k) ? (v === null ? null : '***') : v;
  }
  return out;
}

export function auditDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Record<string, [unknown, unknown]> {
  const diff: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(after)) {
    const b = before ? (before[k] ?? null) : null;
    if (before === null && (v === null || v === undefined)) continue;
    if (JSON.stringify(b) !== JSON.stringify(v ?? null)) diff[k] = [b, v ?? null];
  }
  return diff;
}

export function auditRemoval(before: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(before)) if (v !== null && v !== undefined) out[k] = [v, null];
  return out;
}

export const emptyTables = (): Tables => ({
  regions: [],
  files: [],
  products: [],
  substances: [],
  indicators: [],
  norms: [],
  organizations: [],
  users: [],
  refresh_tokens: [],
  fields: [],
  treatments: [],
  batches: [],
  batch_documents: [],
  batch_links: [],
  batch_status_history: [],
  waybills: [],
  waybill_items: [],
  lab_tests: [],
  lab_results: [],
  recalls: [],
  recall_batches: [],
  recall_tasks: [],
  complaints: [],
  notifications: [],
  audit_log: [],
});

export class Store {
  t: Tables = emptyTables();
  kv = new Map<string, KvEntry>();
  seq: Sequences = { batch: 0, waybill: 0, notification: 0, audit: 0, id: 0 };
  cookies = new Map<string, string>();
  dirty = false;
  requestId: string | null = null;
  epoch: string = hex(randomBytes(8));
  private op: Operation | null = null;
  private byId = new Map<TableName, Map<string, Row>>();

  constructor(private readonly clock: () => number) {}

  now(): number {
    return this.clock();
  }

  nowIso(): string {
    return iso(this.clock());
  }

  id(kind: string): string {
    this.dirty = true;
    this.seq.id += 1;
    return uuidV5(MOCK_NAMESPACE, `${kind}:${this.seq.id}`);
  }

  markDirty(): void {
    this.dirty = true;
  }

  get<T extends TableName>(table: T, id: string | null | undefined): Tables[T][number] | undefined {
    if (!id) return undefined;
    let index = this.byId.get(table);
    if (!index) {
      index = new Map();
      for (const r of this.t[table] as Row[]) if ('id' in r) index.set((r as { id: string }).id, r);
      this.byId.set(table, index);
    }
    return index.get(id) as Tables[T][number] | undefined;
  }

  must<T extends TableName>(table: T, id: string | null | undefined): Tables[T][number] {
    const r = this.get(table, id);
    if (!r) throw new Error(`${table} ${String(id)} not found`);
    return r;
  }

  private indexAdd(table: TableName, row: Row): void {
    const index = this.byId.get(table);
    if (index && 'id' in row) index.set((row as { id: string }).id, row);
  }

  private indexDrop(table: TableName, row: Row): void {
    const index = this.byId.get(table);
    if (index && 'id' in row) index.delete((row as { id: string }).id);
  }

  reindex(): void {
    this.byId.clear();
  }

  insert<T extends TableName>(table: T, row: Tables[T][number]): Tables[T][number] {
    this.dirty = true;
    const list = this.t[table] as Row[];
    list.push(row);
    this.indexAdd(table, row);
    this.op?.undo.push(() => {
      const i = list.lastIndexOf(row);
      if (i >= 0) list.splice(i, 1);
      this.indexDrop(table, row);
    });
    return row;
  }

  patch<R extends object>(row: R, changes: Partial<R>): R {
    this.dirty = true;
    const before: Partial<R> = {};
    for (const k of Object.keys(changes) as (keyof R)[]) before[k] = row[k];
    Object.assign(row, changes);
    this.op?.undo.push(() => Object.assign(row, before));
    return row;
  }

  remove<T extends TableName>(table: T, row: Tables[T][number]): void {
    const list = this.t[table] as Row[];
    const i = list.indexOf(row);
    if (i < 0) return;
    this.dirty = true;
    list.splice(i, 1);
    this.indexDrop(table, row);
    this.op?.undo.push(() => {
      list.splice(i, 0, row);
      this.indexAdd(table, row);
    });
  }

  kvGet<V = unknown>(key: string): V | undefined {
    const e = this.kv.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.kv.delete(key);
      this.dirty = true;
      return undefined;
    }
    return e.value as V;
  }

  kvSet(key: string, value: unknown, ttlSec: number | null): void {
    this.dirty = true;
    const prev = this.kv.get(key);
    this.kv.set(key, { value, expiresAt: ttlSec === null ? null : this.now() + ttlSec * 1000 });
    this.op?.undo.push(() => (prev ? this.kv.set(key, prev) : this.kv.delete(key)));
  }

  kvDel(key: string): void {
    const prev = this.kv.get(key);
    if (!prev) return;
    this.dirty = true;
    this.kv.delete(key);
    this.op?.undo.push(() => this.kv.set(key, prev));
  }

  sweepExpired(): void {
    const now = this.now();
    for (const [key, e] of this.kv)
      if (e.expiresAt !== null && e.expiresAt <= now) {
        this.kv.delete(key);
        this.dirty = true;
      }
  }

  kvTake<V = unknown>(key: string): V | undefined {
    const v = this.kvGet<V>(key);
    if (v !== undefined) this.kvDel(key);
    return v;
  }

  get inOperation(): boolean {
    return this.op !== null;
  }

  run<T>(action: string, actorId: string | null, fn: () => T): T {
    if (this.op) return fn();
    const op: Operation = { action, actorId, undo: [], touched: new Map(), audit: [], afterCommit: [] };
    this.op = op;
    let result: T;
    try {
      result = fn();
      this.flushAudit(op);
    } catch (e) {
      for (let i = op.undo.length - 1; i >= 0; i--) op.undo[i]!();
      this.op = null;
      throw e;
    }
    this.op = null;
    for (const job of op.afterCommit) job();
    return result;
  }

  async runAsync<T>(action: string, actorId: string | null, fn: () => Promise<T>): Promise<T> {
    if (this.op) return fn();
    const op: Operation = { action, actorId, undo: [], touched: new Map(), audit: [], afterCommit: [] };
    this.op = op;
    let result: T;
    try {
      result = await fn();
      this.flushAudit(op);
    } catch (e) {
      for (let i = op.undo.length - 1; i >= 0; i--) op.undo[i]!();
      this.op = null;
      throw e;
    }
    this.op = null;
    for (const job of op.afterCommit) job();
    return result;
  }

  get action(): string {
    return this.op?.action ?? 'system';
  }

  get actorId(): string | null {
    return this.op?.actorId ?? null;
  }

  touch(entityType: string, row: { id: string }): void {
    const op = this.op;
    if (!op || op.touched.has(row)) return;
    op.touched.set(row, { type: entityType, before: auditView(row), id: row.id });
  }

  created(entityType: string, row: { id: string }): void {
    this.op?.touched.set(row, { type: entityType, before: null, id: row.id });
  }

  audit(entry: Omit<AuditRecord, 'action' | 'actorId'> & Partial<Pick<AuditRecord, 'action' | 'actorId'>>): void {
    if (this.op) this.op.audit.push({ action: this.op.action, actorId: this.op.actorId, ...entry });
    else this.writeAudit({ action: entry.action ?? 'system', actorId: entry.actorId ?? null, ...entry });
  }

  afterCommit(job: () => void): void {
    if (this.op) this.op.afterCommit.push(job);
    else job();
  }

  private flushAudit(op: Operation): void {
    for (const [row, t] of op.touched) {
      const diff = auditDiff(t.before, auditView(row));
      if (Object.keys(diff).length === 0) continue;
      this.writeAudit({ action: op.action, actorId: op.actorId, entityType: t.type, entityId: t.id, diff });
    }
    for (const a of op.audit) this.writeAudit(a);
  }

  private writeAudit(a: AuditRecord): void {
    this.seq.audit += 1;
    this.insert('audit_log', {
      id: this.seq.audit,
      actor_id: a.actorId,
      action: a.action,
      entity_type: a.entityType,
      entity_id: a.entityId,
      diff: a.diff,
      ip: a.actorId ? '127.0.0.1' : null,
      backend: 'express',
      request_id: a.actorId === null && a.action.startsWith('system.') ? null : this.requestId,
      created_at: a.at ?? this.nowIso(),
    });
  }
}
