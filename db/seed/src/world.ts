import {
  addWorkingDays,
  canTransition,
  canUseAsInput,
  checkDiscrepancy,
  checkMassBalance,
  checkWaitingPeriod,
  compareDecimalStrings,
  concludeLabTest,
  formatBatchCode,
  nextTrustRating,
  recallTaskDueAt,
  requiresLabTest,
  shouldCloseRecall,
  type BatchStatus,
} from '@agrotrace/domain';
import notificationRules from '../../../contracts/rules/notifications.json' with { type: 'json' };
import mercuryVsd from '../data/vsd.json' with { type: 'json' };
import { shiftVsdDates, type Vsd } from './vsd.js';
import type { OrgType, RoleCode, SeedData } from './data.js';
import { hashInt, uuid } from './ids.js';
import { cmp, iso, plusSeconds, REFERENCE_NOW } from './time.js';

export type Row = Record<string, unknown>;

export type FileSource =
  | { type: 'productPhoto'; file: string }
  | { type: 'logo'; orgKey: string }
  | { type: 'avatar'; name: string }
  | { type: 'qrPng'; publicCode: string }
  | { type: 'qrPdf'; publicCode: string; productName: string; originName: string }
  | { type: 'protocol'; testId: string };

export interface FileSpec {
  id: string;
  kind: 'AVATAR' | 'LOGO' | 'PRODUCT_IMAGE' | 'LAB_PROTOCOL' | 'QR';
  originalName: string;
  ownerId: string | null;
  createdAt: string;
  source: FileSource;
}

export interface AuditEntry {
  action: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  before: Row | null;
  after: Row | (() => Row);
  at: string;
}

interface Notification {
  userId: string;
  type: keyof typeof notificationRules.types;
  payload: Row;
  at: string;
  forced: boolean;
}

type Recipients = { users?: string[]; orgs?: string[]; orgHeads?: string[]; roles?: RoleCode[] };

const LAB_OPEN = new Set(['QUEUED', 'SAMPLED', 'ESCALATED']);
const RECALL_REASON_LAB = 'Превышение нормативов по результатам лабораторного анализа';
const SECRET_COLUMNS = new Set(['password_hash', 'totp_secret']);
const AUDIT_SKIP = new Set(['id', 'created_at', 'updated_at', 'created_by', 'deleted_at']);

const camel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function auditView(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_') || AUDIT_SKIP.has(k)) continue;
    out[camel(k)] = SECRET_COLUMNS.has(k) ? '***' : v;
  }
  return out;
}

export function auditDiff(before: Row | null, after: Row): Row {
  const diff: Row = {};
  for (const [k, v] of Object.entries(after)) {
    const b = before ? before[k] : null;
    if (before === null && (v === null || v === undefined)) continue;
    if (JSON.stringify(b ?? null) !== JSON.stringify(v ?? null)) diff[k] = [b ?? null, v ?? null];
  }
  return diff;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`seed scenario is invalid: ${msg}`);
}

export function firstTickAfter(t: string, seedNow: string): string {
  const step = 5 * 60_000;
  const now = Date.parse(seedNow);
  return iso(now + step * (Math.floor((Date.parse(t) - now) / step) + 1));
}

const ms6 = (v: string): bigint => {
  const [i, f = ''] = v.split('.');
  return BigInt(i!) * 1_000_000n + BigInt(f.padEnd(6, '0').slice(0, 6));
};
const dec6 = (v: bigint): string => `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`;
const mass3 = (v: string): string => {
  const [i, f = ''] = v.split('.');
  return `${BigInt(i!)}.${f.padEnd(3, '0')}`;
};

export interface RegionRef {
  id: string;
  code: string;
}

export class World {
  readonly t = {
    files: [] as Row[],
    products: [] as Row[],
    substances: [] as Row[],
    indicators: [] as Row[],
    norms: [] as Row[],
    organizations: [] as Row[],
    users: [] as Row[],
    user_roles: [] as Row[],
    fields: [] as Row[],
    treatments: [] as Row[],
    batches: [] as Row[],
    batch_documents: [] as Row[],
    batch_links: [] as Row[],
    batch_status_history: [] as Row[],
    waybills: [] as Row[],
    waybill_items: [] as Row[],
    lab_tests: [] as Row[],
    lab_results: [] as Row[],
    recalls: [] as Row[],
    recall_batches: [] as Row[],
    recall_tasks: [] as Row[],
    complaints: [] as Row[],
  };
  readonly files: FileSpec[] = [];
  readonly audit: AuditEntry[] = [];
  readonly notifications: Notification[] = [];
  readonly keys = {
    org: new Map<string, Row>(),
    user: new Map<string, Row>(),
    product: new Map<string, Row>(),
    substance: new Map<string, Row>(),
    indicator: new Map<string, Row>(),
    field: new Map<string, Row>(),
    batch: new Map<string, Row>(),
    waybill: new Map<string, Row>(),
    test: new Map<string, Row>(),
    recall: new Map<string, Row>(),
    complaint: new Map<string, Row>(),
  };
  private clock = '2000-01-01T00:00:00Z';
  private batchSeq = 0;
  private waybillSeq = 0;
  private op: {
    action: string;
    actorId: string | null;
    at: string;
    touched: Map<Row, { type: string; before: Row | null }>;
  } | null = null;
  private readonly regionByCode: Map<string, string>;
  private readonly roleIdByCode: Map<string, number>;
  private readonly rolesByUser = new Map<string, RoleCode[]>();

  constructor(
    readonly data: SeedData,
    regions: RegionRef[],
    roles: { id: number; code: string }[],
    readonly bucket: string,
    readonly publicBaseUrl: string,
    readonly seedNow: string,
  ) {
    this.regionByCode = new Map(regions.map((r) => [r.code, r.id]));
    this.roleIdByCode = new Map(roles.map((r) => [r.code, r.id]));
  }

  get year(): number {
    return new Date(this.seedNow).getUTCFullYear();
  }

  story(t: string): string {
    return iso(Date.parse(t) + Date.parse(this.seedNow) - Date.parse(REFERENCE_NOW));
  }

  private async(at: string, seconds: number): string {
    const t = plusSeconds(at, seconds);
    return cmp(t, this.seedNow) > 0 ? this.seedNow : t;
  }

  private region(code: string): string {
    const id = this.regionByCode.get(code);
    assert(id, `unknown region ${code}`);
    return id;
  }

  private begin(action: string, actorKey: string | null, at: string, scheduler = false): void {
    assert(!this.op, 'nested operation');
    if (scheduler) assert(at === this.clock, 'scheduler tick out of order');
    else this.advance(at);
    this.op = {
      action,
      actorId: actorKey ? (this.user(actorKey).id as string) : null,
      at: this.clock,
      touched: new Map(),
    };
  }

  private end(): void {
    const op = this.op!;
    this.op = null;
    for (const [row, { type, before }] of op.touched) {
      const after = type === 'file' ? () => auditView(row) : auditView(row);
      this.audit.push({
        action: op.action,
        actorId: op.actorId,
        entityType: type,
        entityId: row.id as string,
        before,
        after,
        at: op.at,
      });
    }
  }

  private touch(type: string, row: Row): void {
    const op = this.op!;
    if (!op.touched.has(row)) op.touched.set(row, { type, before: auditView(row) });
    if ('updated_at' in row) row.updated_at = op.at;
  }

  private created(type: string, row: Row): void {
    this.op!.touched.set(row, { type, before: null });
  }

  advance(to: string): void {
    assert(cmp(to, this.clock) >= 0, `time goes backwards: ${to} < ${this.clock}`);
    for (;;) {
      const next = this.nextSchedulerEvent(to);
      if (!next) break;
      this.clock = next.at;
      next.run();
    }
    this.clock = to;
  }

  private nextSchedulerEvent(limit: string): { at: string; run: () => void } | null {
    let best: { at: string; id: string; run: () => void } | null = null;
    const consider = (at: string, id: string, run: () => void): void => {
      if (cmp(at, limit) > 0) return;
      if (!best || cmp(at, best.at) < 0 || (at === best.at && id < best.id)) best = { at, id, run };
    };
    for (const test of this.t.lab_tests) {
      if (test.status !== 'QUEUED' && test.status !== 'SAMPLED') continue;
      const tick = firstTickAfter(test.due_at as string, this.seedNow);
      consider(tick, `a${test.id as string}`, () => this.escalateLabTest(test, tick));
    }
    for (const task of this.t.recall_tasks) {
      if (task.status !== 'OPEN') continue;
      const tick = firstTickAfter(task.due_at as string, this.seedNow);
      consider(tick, `b${task.id as string}`, () => this.escalateRecallTask(task, tick));
    }
    return best;
  }

  org(key: string): Row {
    const r = this.keys.org.get(key);
    assert(r, `unknown organization ${key}`);
    return r;
  }
  user(key: string): Row {
    const r = this.keys.user.get(key);
    assert(r, `unknown user ${key}`);
    return r;
  }
  batch(key: string): Row {
    const r = this.keys.batch.get(key);
    assert(r, `unknown batch ${key}`);
    return r;
  }
  test(key: string): Row {
    const r = this.keys.test.get(key);
    assert(r, `unknown lab test ${key}`);
    return r;
  }
  waybill(key: string): Row {
    const r = this.keys.waybill.get(key);
    assert(r, `unknown waybill ${key}`);
    return r;
  }
  recall(key: string): Row {
    const r = this.keys.recall.get(key);
    assert(r, `unknown recall ${key}`);
    return r;
  }
  complaint(key: string): Row {
    const r = this.keys.complaint.get(key);
    assert(r, `unknown complaint ${key}`);
    return r;
  }
  private byId<T extends keyof World['t']>(table: T, id: unknown): Row {
    const r = this.t[table].find((x) => x.id === id);
    assert(r, `${table} ${String(id)} not found`);
    return r;
  }
  orgById(id: unknown): Row {
    return this.byId('organizations', id);
  }
  productById(id: unknown): Row {
    return this.byId('products', id);
  }
  batchById(id: unknown): Row {
    return this.byId('batches', id);
  }
  task(recallKey: string, batchKey: string): Row {
    const recall = this.recall(recallKey);
    const b = this.batch(batchKey);
    const r = this.t.recall_tasks.find((x) => x.recall_id === recall.id && x.batch_id === b.id);
    assert(r, `no task for ${batchKey} in recall ${recallKey}`);
    return r;
  }

  private orgOfUser(userKey: string): Row {
    return this.orgById(this.user(userKey).organization_id);
  }

  private requireRole(userKey: string, ...roles: RoleCode[]): Row {
    const u = this.user(userKey);
    const has = this.rolesByUser.get(u.id as string) ?? [];
    assert(
      roles.some((r) => has.includes(r)),
      `${userKey} lacks role ${roles.join('|')}`,
    );
    return this.orgOfUser(userKey);
  }

  private activeUsers(pred: (u: Row) => boolean): string[] {
    return this.t.users
      .filter((u) => u.status === 'ACTIVE' && u.deleted_at === null && pred(u))
      .map((u) => u.id as string);
  }

  private notify(type: Notification['type'], recipients: Recipients, payload: Row, at: string): void {
    const keys = notificationRules.types[type].payload;
    assert(
      JSON.stringify([...keys].sort()) === JSON.stringify(Object.keys(payload).sort()),
      `${type} payload keys ${Object.keys(payload).join(',')}`,
    );
    const ids: string[] = [];
    const add = (list: string[]): void => {
      for (const id of list) if (!ids.includes(id)) ids.push(id);
    };
    add(this.activeUsers((u) => (recipients.users ?? []).includes(u.id as string)));
    for (const org of recipients.orgs ?? []) add(this.activeUsers((u) => u.organization_id === org));
    for (const org of recipients.orgHeads ?? [])
      add(this.activeUsers((u) => u.organization_id === org && u.is_org_admin === true));
    for (const role of recipients.roles ?? [])
      add(this.activeUsers((u) => (this.rolesByUser.get(u.id as string) ?? []).includes(role)));
    const forced = notificationRules.forcedChannels.includes(type);
    for (const userId of ids)
      this.notifications.push({ userId, type, payload, at: this.async(at, 2), forced });
  }

  private addFile(spec: Omit<FileSpec, 'id'> & { key: string }): string {
    const id = uuid('file', spec.key);
    this.files.push({
      id,
      kind: spec.kind,
      originalName: spec.originalName,
      ownerId: spec.ownerId,
      createdAt: spec.createdAt,
      source: spec.source,
    });
    const row: Row = { id, _file: true };
    this.t.files.push(row);
    return id;
  }

  seedDictionaries(at: string, adminKey: string): void {
    this.begin('seed', null, at);
    const admin = this.user(adminKey);
    for (const p of this.data.products) {
      const id = uuid('product', p.key);
      const fileId = this.addFile({
        key: `product:${p.key}`,
        kind: 'PRODUCT_IMAGE',
        originalName: p.image,
        ownerId: admin.id as string,
        createdAt: at,
        source: { type: 'productPhoto', file: p.image },
      });
      const row: Row = {
        id,
        name: p.name,
        category: p.category,
        loss_norm_percent: p.lossNormPercent,
        image_file_id: fileId,
        mercury_code: p.mercuryCode ?? null,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      };
      this.t.products.push(row);
      this.keys.product.set(p.key, row);
      this.created('product', row);
      this.created(
        'file',
        this.t.files.find((f) => f.id === fileId)!,
      );
    }
    for (const s of this.data.substances) {
      const row: Row = {
        id: uuid('substance', s.key),
        name: s.name,
        type: s.type,
        waiting_period_days: s.waitingPeriodDays,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      };
      this.t.substances.push(row);
      this.keys.substance.set(s.key, row);
      this.created('substance', row);
    }
    for (const i of this.data.indicators) {
      const row: Row = {
        id: uuid('indicator', i.key),
        name: i.name,
        unit: i.unit,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      };
      this.t.indicators.push(row);
      this.keys.indicator.set(i.key, row);
      this.created('indicator', row);
    }
    for (const [pk, norms] of Object.entries(this.data.norms)) {
      const product = this.keys.product.get(pk);
      assert(product, `norms for unknown product ${pk}`);
      const n = Object.keys(norms).length;
      assert(n >= 3 && n <= 5, `product ${pk} must have 3–5 norms, has ${n}`);
      for (const [ik, max] of Object.entries(norms)) {
        const indicator = this.keys.indicator.get(ik);
        assert(indicator, `norm for unknown indicator ${ik}`);
        const row: Row = {
          id: uuid('norm', `${pk}:${ik}`),
          product_id: product.id,
          indicator_id: indicator.id,
          max_value: dec6(ms6(max)),
          created_at: at,
          updated_at: at,
        };
        this.t.norms.push(row);
        this.created('norm', row);
      }
    }
    this.end();
  }

  seedOrganizations(at: string): void {
    this.begin('seed', null, at);
    for (const o of this.data.organizations) {
      const id = uuid('organization', o.key);
      const row: Row = {
        id,
        type: o.type,
        name: o.name,
        inn: o.inn,
        address: o.address,
        region_id: this.region(o.regionCode),
        trust_rating: o.type === 'FARM' ? 80 : null,
        status: 'ACTIVE',
        logo_file_id: null,
        created_at: at,
        updated_at: at,
        created_by: null,
        deleted_at: null,
      };
      this.t.organizations.push(row);
      this.keys.org.set(o.key, row);
    }
    const ordered = [...this.data.users].sort((a, b) => Number(b.isOrgAdmin) - Number(a.isOrgAdmin));
    for (const u of ordered) {
      const org = this.org(u.org);
      const head = this.data.users.find((x) => x.org === u.org && x.isOrgAdmin);
      assert(head, `organization ${u.org} has no head`);
      assert(u.email === u.email.toLowerCase(), `email must be lowercase: ${u.email}`);
      const id = uuid('user', u.key);
      const row: Row = {
        id,
        organization_id: org.id,
        email: u.email,
        password_hash: null,
        full_name: u.fullName,
        phone: u.phone,
        is_org_admin: u.isOrgAdmin,
        totp_secret: null,
        totp_enabled: false,
        telegram_chat_id: null,
        notification_channels: { email: true, telegram: false },
        avatar_file_id: null,
        failed_logins: 0,
        locked_until: null,
        status: 'ACTIVE',
        created_at: at,
        updated_at: at,
        created_by: u.isOrgAdmin ? null : uuid('user', head.key),
        deleted_at: null,
        _key: u.key,
      };
      this.t.users.push(row);
      this.keys.user.set(u.key, row);
      this.rolesByUser.set(id, u.roles);
      for (const role of u.roles) {
        const roleId = this.roleIdByCode.get(role);
        assert(roleId !== undefined, `unknown role ${role}`);
        this.t.user_roles.push({ id: uuid('user_role', `${u.key}:${role}`), user_id: id, role_id: roleId });
      }
      const expected: Record<OrgType, RoleCode> = {
        FARM: 'FARMER',
        PROCESSOR: 'PROCESSOR',
        LAB: 'LAB',
        RETAILER: 'RETAILER',
        AUTHORITY: 'INSPECTOR',
        PLATFORM: 'ADMIN',
      };
      assert(
        u.roles.every((r) => r === expected[org.type as OrgType]),
        `role of ${u.key} does not match organization type`,
      );
    }
    const newFiles: string[] = [];
    for (const o of this.data.organizations) {
      const org = this.org(o.key);
      const head = this.data.users.find((x) => x.org === o.key && x.isOrgAdmin)!;
      org.logo_file_id = this.addFile({
        key: `logo:${o.key}`,
        kind: 'LOGO',
        originalName: `${o.key}.svg`,
        ownerId: uuid('user', head.key),
        createdAt: at,
        source: { type: 'logo', orgKey: o.key },
      });
      newFiles.push(org.logo_file_id as string);
    }
    for (const u of this.data.users) {
      if (!u.avatar) continue;
      this.user(u.key).avatar_file_id = this.addFile({
        key: `avatar:${u.key}`,
        kind: 'AVATAR',
        originalName: `${u.avatar}.jpg`,
        ownerId: uuid('user', u.key),
        createdAt: at,
        source: { type: 'avatar', name: u.avatar },
      });
      newFiles.push(this.user(u.key).avatar_file_id as string);
    }
    for (const org of this.t.organizations) this.created('organization', org);
    for (const user of this.t.users) this.created('user', user);
    for (const id of newFiles)
      this.created(
        'file',
        this.t.files.find((f) => f.id === id)!,
      );
    this.end();
  }

  createField(at: string, userKey: string, fieldKey: string): Row {
    this.begin('createField', userKey, at);
    const org = this.requireRole(userKey, 'FARMER');
    const f = this.data.fields.find((x) => x.key === fieldKey);
    assert(f, `unknown field ${fieldKey}`);
    assert(this.org(f.org) === org, `field ${fieldKey} belongs to another farm`);
    const ring = f.geometry.coordinates[0]!;
    assert(
      JSON.stringify(ring[0]) === JSON.stringify(ring[ring.length - 1]) && ring.length >= 4,
      `field ${fieldKey} ring not closed`,
    );
    const row: Row = {
      id: uuid('field', f.key),
      organization_id: org.id,
      name: f.name,
      area_ha: f.areaHa,
      geometry: f.geometry,
      region_id: this.region(f.regionCode),
      created_at: this.clock,
      updated_at: this.clock,
      created_by: this.user(userKey).id,
      deleted_at: null,
    };
    this.t.fields.push(row);
    this.keys.field.set(f.key, row);
    this.created('field', row);
    this.end();
    return row;
  }

  createTreatment(
    at: string,
    userKey: string,
    fieldKey: string,
    substanceKey: string,
    dose: string,
    doseUnit: 'л/га' | 'мл/га' | 'кг/га' | 'г/га',
    appliedAt: string,
  ): Row {
    this.begin('createTreatment', userKey, at);
    const org = this.requireRole(userKey, 'FARMER');
    const field = this.keys.field.get(fieldKey);
    assert(field && field.organization_id === org.id, `field ${fieldKey} not visible to ${userKey}`);
    const substance = this.keys.substance.get(substanceKey);
    assert(substance, `unknown substance ${substanceKey}`);
    assert(cmp(appliedAt, this.clock) <= 0, 'treatment appliedAt in the future');
    assert(/^\d{1,7}\.\d{3}$/.test(dose) && dose !== '0.000', `bad dose ${dose}`);
    const row: Row = {
      id: uuid('treatment', `${fieldKey}:${substanceKey}:${appliedAt}`),
      field_id: field.id,
      substance_id: substance.id,
      dose,
      dose_unit: doseUnit,
      applied_at: appliedAt,
      created_at: this.clock,
      updated_at: this.clock,
      created_by: this.user(userKey).id,
      deleted_at: null,
    };
    this.t.treatments.push(row);
    this.created('treatment', row);
    this.end();
    return row;
  }

  private transition(b: Row, to: BatchStatus, reason: string, byUserId: string | null): void {
    const from = b.status as BatchStatus;
    assert(
      canTransition({ from, to }).allowed,
      `batch ${b.public_code as string}: ${from} → ${to} is not allowed`,
    );
    this.touch('batch', b);
    b.status = to;
    b.version = (b.version as number) + 1;
    this.t.batch_status_history.push({
      batch_id: b.id,
      from_status: from,
      to_status: to,
      changed_by: byUserId,
      reason,
      changed_at: this.clock,
    });
  }

  private newBatch(key: string, fields: Row): Row {
    assert(!this.keys.batch.has(key), `duplicate batch key ${key}`);
    this.batchSeq += 1;
    const row: Row = {
      id: uuid('batch', key),
      public_code: formatBatchCode({ year: this.year, seq: this.batchSeq }).code,
      product_id: null,
      origin_org_id: null,
      holder_org_id: null,
      field_id: null,
      kind: 'RAW',
      mass_kg: null,
      harvested_at: null,
      produced_at: null,
      status: 'Created',
      test_required: false,
      test_reason: 'NONE',
      qr_generated_at: null,
      qr_png_file_id: null,
      qr_pdf_file_id: null,
      version: 1,
      created_at: this.clock,
      updated_at: this.clock,
      created_by: null,
      deleted_at: null,
      _key: key,
      ...fields,
    };
    this.t.batches.push(row);
    this.keys.batch.set(key, row);
    this.created('batch', row);
    this.t.batch_status_history.push({
      batch_id: row.id,
      from_status: null,
      to_status: 'Created',
      changed_by: row.created_by,
      reason: 'CREATED',
      changed_at: this.clock,
    });
    return row;
  }

  private ratingOf(orgId: unknown): number {
    return this.orgById(orgId).trust_rating as number;
  }

  foldRating(orgId: unknown): number {
    type E = { at: string; order: number; id: string; event: 'LAB_PASS' | 'LAB_FAIL' | 'RECALL_SOURCE' };
    const events: E[] = [];
    const own = (batchId: unknown): boolean => {
      const b = this.batchById(batchId);
      return b.origin_org_id === orgId && b.deleted_at === null;
    };
    for (const t of this.t.lab_tests) {
      if (t.status === 'DONE' && t.deleted_at === null && own(t.batch_id)) {
        events.push({
          at: t.completed_at as string,
          order: 0,
          id: t.id as string,
          event: t.conclusion === 'PASS' ? 'LAB_PASS' : 'LAB_FAIL',
        });
      }
    }
    for (const r of this.t.recalls) {
      const b = this.batchById(r.source_batch_id);
      if (r.deleted_at === null && b.origin_org_id === orgId) {
        events.push({ at: r.opened_at as string, order: 1, id: r.id as string, event: 'RECALL_SOURCE' });
      }
    }
    events.sort((a, b) => cmp(a.at, b.at) || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return events.reduce((current, e) => nextTrustRating({ current, event: e.event }).rating, 80);
  }

  private recalculateRating(orgId: unknown, at: string): void {
    const org = this.orgById(orgId);
    if (org.type !== 'FARM') return;
    const rating = this.foldRating(orgId);
    if (rating === org.trust_rating) return;
    const before = auditView(org);
    org.trust_rating = rating;
    org.updated_at = this.async(at, 3);
    this.audit.push({
      action: 'system.ratingRecalculate',
      actorId: null,
      entityType: 'organization',
      entityId: org.id as string,
      before,
      after: auditView(org),
      at: this.async(at, 3),
    });
  }

  private chooseLab(fieldRegionId: unknown): Row {
    const labs = this.t.organizations.filter((o) => o.type === 'LAB' && o.status === 'ACTIVE');
    assert(labs.length > 0, 'NO_LAB_AVAILABLE');
    const local = labs.filter((l) => l.region_id === fieldRegionId);
    const pool = local.length ? local : labs;
    const load = (l: Row): number =>
      this.t.lab_tests.filter(
        (x) => x.lab_org_id === l.id && x.deleted_at === null && LAB_OPEN.has(x.status as string),
      ).length;
    return [...pool].sort((a, b) => load(a) - load(b) || ((a.id as string) < (b.id as string) ? -1 : 1))[0]!;
  }

  private newLabTest(key: string, batch: Row, lab: Row, reason: string, createdBy: string | null): Row {
    assert(!this.keys.test.has(key), `duplicate lab test key ${key}`);
    const row: Row = {
      id: uuid('lab_test', key),
      batch_id: batch.id,
      lab_org_id: lab.id,
      reason,
      status: 'QUEUED',
      conclusion: null,
      sampled_at: null,
      completed_at: null,
      due_at: iso(addWorkingDays({ from: this.clock, days: 5 }).result),
      escalated_at: null,
      protocol_file_id: null,
      version: 1,
      created_at: this.clock,
      updated_at: this.clock,
      created_by: createdBy,
      deleted_at: null,
      recall_id: null,
      _key: key,
    };
    this.t.lab_tests.push(row);
    this.keys.test.set(key, row);
    this.created('labTest', row);
    const product = this.productById(batch.product_id);
    this.notify(
      'LAB_ASSIGNED',
      { orgs: [lab.id as string, batch.origin_org_id as string] },
      {
        labTestId: row.id,
        batchId: batch.id,
        publicCode: batch.public_code,
        productName: product.name,
        labOrgId: lab.id,
        labName: lab.name,
        reason,
        dueAt: row.due_at,
      },
      this.clock,
    );
    return row;
  }

  createBatch(
    at: string,
    userKey: string,
    key: string,
    a: { field: string; product: string; massKg: string; harvestedAt: string },
  ): Row {
    this.begin('createBatch', userKey, at);
    const org = this.requireRole(userKey, 'FARMER');
    const user = this.user(userKey);
    const field = this.keys.field.get(a.field);
    assert(
      field && field.organization_id === org.id && field.deleted_at === null,
      `field ${a.field} is not ${userKey}'s`,
    );
    const product = this.keys.product.get(a.product);
    assert(product && product.category !== 'PROCESSED', `product ${a.product} cannot be a raw batch`);
    assert(cmp(a.harvestedAt, this.clock) <= 0, 'harvestedAt in the future');
    const farmBatchCount = this.t.batches.filter(
      (b) => b.origin_org_id === org.id && b.kind === 'RAW' && b.deleted_at === null,
    ).length;
    const b = this.newBatch(key, {
      product_id: product.id,
      origin_org_id: org.id,
      holder_org_id: org.id,
      field_id: field.id,
      kind: 'RAW',
      mass_kg: mass3(a.massKg),
      harvested_at: a.harvestedAt,
      created_by: user.id,
    });
    const since = Date.parse(this.clock) - 30 * 86_400_000;
    const pesticides = this.t.treatments.filter((t) => {
      const s = this.t.substances.find((x) => x.id === t.substance_id)!;
      const ts = Date.parse(t.applied_at as string);
      return (
        t.field_id === field.id &&
        t.deleted_at === null &&
        s.type === 'PESTICIDE' &&
        ts >= since &&
        ts <= Date.parse(this.clock)
      );
    }).length;
    const risk = requiresLabTest({
      publicCode: b.public_code as string,
      farmBatchCount,
      trustRating: this.ratingOf(org.id),
      pesticideTreatmentsLast30Days: pesticides,
    });
    b.test_required = risk.required;
    b.test_reason = risk.reason;
    if (!risk.required) {
      this.transition(b, 'Approved', 'TEST_NOT_REQUIRED', null);
    } else {
      const lab = this.chooseLab(field.region_id);
      this.newLabTest(`${key}:risk`, b, lab, risk.reason === 'SAMPLED' ? 'PLANNED' : 'RISK', null);
      this.transition(b, 'OnTest', 'TEST_REQUIRED', null);
    }
    let vsd: Row | null = null;
    if (product.category === 'DAIRY' || product.category === 'MEAT') {
      vsd = {
        id: uuid('batch_document', `${key}:VSD`),
        batch_id: b.id,
        kind: 'VSD',
        external_uuid: null,
        number: null,
        issue_date: null,
        vsd_status: null,
        import_status: 'PENDING',
        payload: null,
        attempts: 0,
        last_error: null,
        created_at: this.clock,
        updated_at: this.clock,
      };
      this.t.batch_documents.push(vsd);
      this.created('batchDocument', vsd);
    }
    this.end();
    if (vsd) this.importVsd(vsd, b, this.async(this.clock, 4));
    return b;
  }

  private importVsd(doc: Row, b: Row, at: string): void {
    const code = this.productById(b.product_id).mercury_code as string | null;
    const inn = this.orgById(b.origin_org_id).inn as string;
    const before = auditView(doc);
    let found: Vsd | undefined;
    if (code) {
      const h = Date.parse(b.harvested_at as string);
      const from = iso(h - 3 * 86_400_000).slice(0, 10);
      const to = iso(h + 3 * 86_400_000).slice(0, 10);
      const desc = (x: string, y: string): number => (x < y ? 1 : x > y ? -1 : 0);
      found = shiftVsdDates(mercuryVsd as Vsd[], Date.parse(this.seedNow))
        .filter(
          (v) =>
            v.product.code === code &&
            v.consignor.inn === inn &&
            v.issueDate >= from &&
            v.issueDate <= to &&
            v.status === 'CONFIRMED',
        )
        .sort(
          (x, y) => desc(x.issueDate, y.issueDate) || desc(x.number, y.number) || desc(x.uuid, y.uuid),
        )[0];
      doc.attempts = 1;
    }
    if (found) {
      Object.assign(doc, {
        import_status: 'IMPORTED',
        external_uuid: found.uuid,
        number: found.number,
        issue_date: found.issueDate,
        vsd_status: found.status,
        payload: found,
      });
    } else {
      doc.import_status = 'NOT_FOUND';
    }
    doc.updated_at = at;
    this.audit.push({
      action: 'system.vsdImport',
      actorId: null,
      entityType: 'batchDocument',
      entityId: doc.id as string,
      before,
      after: auditView(doc),
      at,
    });
  }

  processBatches(
    at: string,
    userKey: string,
    inputs: { batch: string; massUsedKg: string }[],
    outputs: { key: string; product: string; massKg: string }[],
  ): Row[] {
    this.begin('processBatches', userKey, at);
    const org = this.requireRole(userKey, 'PROCESSOR');
    const user = this.user(userKey);
    const ins = inputs.map((i) => ({ row: this.batch(i.batch), massUsedKg: mass3(i.massUsedKg) }));
    for (const i of ins) {
      assert(i.row.holder_org_id === org.id, `NOT_HOLDER ${i.row.public_code as string}`);
      assert(
        !['Blocked', 'Recalled'].includes(i.row.status as string),
        `BR-06 ${i.row.public_code as string}`,
      );
      assert(
        canUseAsInput({ status: i.row.status as BatchStatus }).allowed,
        `BR-05 ${i.row.public_code as string} ${i.row.status as string}`,
      );
      assert(
        compareDecimalStrings(i.massUsedKg, i.row.mass_kg as string) <= 0,
        `massUsedKg exceeds batch ${i.row.public_code as string}`,
      );
    }
    const balance = checkMassBalance({
      inputs: ins.map((i) => ({
        massUsedKg: i.massUsedKg,
        lossNormPercent: this.productById(i.row.product_id).loss_norm_percent as string,
      })),
      outputs: outputs.map((o) => ({ massKg: mass3(o.massKg) })),
    });
    assert('ok' in balance && balance.ok, `BR-04 ${JSON.stringify(balance)}`);
    for (const i of ins) this.transition(i.row, 'Processed', 'PROCESSED', user.id as string);
    const created: Row[] = [];
    for (const o of outputs) {
      const product = this.keys.product.get(o.product);
      assert(product && product.deleted_at === null, `unknown product ${o.product}`);
      const b = this.newBatch(o.key, {
        product_id: product.id,
        origin_org_id: org.id,
        holder_org_id: org.id,
        kind: 'DERIVED',
        mass_kg: mass3(o.massKg),
        produced_at: this.clock,
        test_required: false,
        test_reason: 'NONE',
        created_by: user.id,
      });
      this.transition(b, 'Approved', 'TEST_NOT_REQUIRED', null);
      for (const i of ins) {
        this.t.batch_links.push({
          id: uuid('batch_link', `${i.row._key as string}>${o.key}`),
          parent_batch_id: i.row.id,
          child_batch_id: b.id,
          mass_used_kg: i.massUsedKg,
          created_at: this.clock,
        });
      }
      created.push(b);
    }
    this.end();
    return created;
  }

  putOnSale(at: string, userKey: string, batchKey: string): void {
    this.begin('putBatchOnSale', userKey, at);
    const org = this.requireRole(userKey, 'RETAILER');
    const b = this.batch(batchKey);
    assert(b.holder_org_id === org.id, `NOT_HOLDER ${batchKey}`);
    this.transition(b, 'OnSale', 'ON_SALE', this.user(userKey).id as string);
    this.end();
  }

  markSold(at: string, userKey: string, batchKey: string): void {
    this.begin('markBatchSold', userKey, at);
    const org = this.requireRole(userKey, 'RETAILER');
    const b = this.batch(batchKey);
    assert(b.holder_org_id === org.id, `NOT_HOLDER ${batchKey}`);
    this.transition(b, 'Sold', 'SOLD', this.user(userKey).id as string);
    this.end();
  }

  createBatchQr(at: string, userKey: string, batchKey: string): void {
    this.begin('createBatchQr', userKey, at);
    const org = this.requireRole(userKey, 'PROCESSOR', 'RETAILER');
    const b = this.batch(batchKey);
    assert(b.holder_org_id === org.id, `NOT_HOLDER ${batchKey}`);
    const allowed =
      ['Accepted', 'OnSale'].includes(b.status as string) ||
      (b.status === 'Approved' &&
        b.kind === 'DERIVED' &&
        b.origin_org_id === org.id &&
        org.type === 'PROCESSOR');
    assert(allowed, `QR not allowed for ${batchKey} in ${b.status as string}`);
    assert(b.qr_png_file_id === null, `QR regeneration is not modelled (${batchKey})`);
    const code = b.public_code as string;
    const user = this.user(userKey);
    const png = this.addFile({
      key: `qr-png:${batchKey}`,
      kind: 'QR',
      originalName: `${code}.png`,
      ownerId: user.id as string,
      createdAt: this.clock,
      source: { type: 'qrPng', publicCode: code },
    });
    const pdf = this.addFile({
      key: `qr-pdf:${batchKey}`,
      kind: 'QR',
      originalName: `${code}.pdf`,
      ownerId: user.id as string,
      createdAt: this.clock,
      source: {
        type: 'qrPdf',
        publicCode: code,
        productName: this.productById(b.product_id).name as string,
        originName: this.orgById(b.origin_org_id).name as string,
      },
    });
    this.touch('batch', b);
    b.qr_png_file_id = png;
    b.qr_pdf_file_id = pdf;
    b.qr_generated_at = this.clock;
    this.created(
      'file',
      this.t.files.find((f) => f.id === png)!,
    );
    this.created(
      'file',
      this.t.files.find((f) => f.id === pdf)!,
    );
    this.end();
  }

  createWaybill(
    at: string,
    userKey: string,
    key: string,
    receiverKey: string,
    items: { batch: string; massDeclaredKg?: string }[],
  ): Row {
    this.begin('createWaybill', userKey, at);
    const org = this.requireRole(userKey, 'FARMER', 'PROCESSOR');
    const receiver = this.org(receiverKey);
    assert(
      ['PROCESSOR', 'RETAILER'].includes(receiver.type as string) && receiver.status === 'ACTIVE',
      'receiver type',
    );
    assert(receiver.id !== org.id, 'receiver is the sender');
    assert(new Set(items.map((i) => i.batch)).size === items.length, 'duplicate batch in waybill');
    this.waybillSeq += 1;
    const row: Row = {
      id: uuid('waybill', key),
      number: `WB-${this.year}-${String(this.waybillSeq).padStart(6, '0')}`,
      sender_org_id: org.id,
      receiver_org_id: receiver.id,
      status: 'DRAFT',
      reject_reason: null,
      sent_at: null,
      accepted_at: null,
      version: 1,
      created_at: this.clock,
      updated_at: this.clock,
      created_by: this.user(userKey).id,
      deleted_at: null,
      _key: key,
    };
    this.t.waybills.push(row);
    this.keys.waybill.set(key, row);
    this.created('waybill', row);
    for (const i of items) {
      const b = this.batch(i.batch);
      assert(b.holder_org_id === org.id, `NOT_HOLDER ${i.batch}`);
      const declared = mass3(i.massDeclaredKg ?? (b.mass_kg as string));
      assert(compareDecimalStrings(declared, b.mass_kg as string) <= 0, `declared mass exceeds ${i.batch}`);
      this.t.waybill_items.push({
        id: uuid('waybill_item', `${key}:${i.batch}`),
        waybill_id: row.id,
        batch_id: b.id,
        mass_declared_kg: declared,
        mass_actual_kg: null,
        discrepancy_act: null,
      });
    }
    this.end();
    return row;
  }

  private itemsOf(w: Row): { item: Row; batch: Row }[] {
    return this.t.waybill_items
      .filter((i) => i.waybill_id === w.id)
      .map((item) => ({ item, batch: this.batchById(item.batch_id) }))
      .sort((a, b) => ((a.batch.public_code as string) < (b.batch.public_code as string) ? -1 : 1));
  }

  sendWaybill(at: string, userKey: string, key: string): void {
    this.begin('sendWaybill', userKey, at);
    const org = this.requireRole(userKey, 'FARMER', 'PROCESSOR');
    const w = this.waybill(key);
    assert(w.sender_org_id === org.id, 'NOT_SENDER');
    assert(w.status === 'DRAFT', `waybill ${key} is ${w.status as string}`);
    const shipDate = this.clock.slice(0, 10);
    for (const { batch } of this.itemsOf(w)) {
      assert(batch.holder_org_id === org.id, `NOT_HOLDER ${batch.public_code as string}`);
      assert(
        !['Blocked', 'Recalled'].includes(batch.status as string),
        `BR-06 ${batch.public_code as string}`,
      );
      assert(
        ['Approved', 'Accepted'].includes(batch.status as string),
        `INVALID_TRANSITION ${batch.public_code as string}`,
      );
      if (batch.kind === 'RAW') {
        const treatments = this.t.treatments
          .filter((t) => t.field_id === batch.field_id && t.deleted_at === null)
          .map((t) => {
            const s = this.t.substances.find((x) => x.id === t.substance_id)!;
            return {
              substance: s.name as string,
              appliedAt: t.applied_at as string,
              waitingPeriodDays: s.waiting_period_days as number,
            };
          });
        const br01 = checkWaitingPeriod({ shipDate, treatments });
        assert(br01.ok, `BR-01 ${batch.public_code as string}: ${JSON.stringify(br01)}`);
      }
    }
    this.touch('waybill', w);
    w.status = 'SENT';
    w.sent_at = this.clock;
    w.version = (w.version as number) + 1;
    for (const { batch } of this.itemsOf(w))
      this.transition(batch, 'InTransit', 'WAYBILL_SENT', this.user(userKey).id as string);
    this.end();
    this.notify(
      'WAYBILL_INCOMING',
      { orgs: [w.receiver_org_id as string] },
      {
        waybillId: w.id,
        number: w.number,
        senderOrgId: org.id,
        senderName: org.name,
        itemsCount: this.itemsOf(w).length,
      },
      this.clock,
    );
  }

  br01(at: string, key: string): ReturnType<typeof checkWaitingPeriod>[] {
    const w = this.waybill(key);
    return this.itemsOf(w)
      .filter(({ batch }) => batch.kind === 'RAW')
      .map(({ batch }) =>
        checkWaitingPeriod({
          shipDate: at.slice(0, 10),
          treatments: this.t.treatments
            .filter((t) => t.field_id === batch.field_id && t.deleted_at === null)
            .map((t) => {
              const s = this.t.substances.find((x) => x.id === t.substance_id)!;
              return {
                substance: s.name as string,
                appliedAt: t.applied_at as string,
                waitingPeriodDays: s.waiting_period_days as number,
              };
            }),
        }),
      );
  }

  acceptWaybill(
    at: string,
    userKey: string,
    key: string,
    actual: Record<string, { massKg: string; act?: string }> = {},
  ): void {
    this.begin('acceptWaybill', userKey, at);
    const org = this.requireRole(userKey, 'PROCESSOR', 'RETAILER');
    const w = this.waybill(key);
    assert(w.receiver_org_id === org.id, 'NOT_RECEIVER');
    assert(w.status === 'SENT', `waybill ${key} is ${w.status as string}`);
    this.touch('waybill', w);
    w.status = 'ACCEPTED';
    w.accepted_at = this.clock;
    w.version = (w.version as number) + 1;
    for (const { item, batch } of this.itemsOf(w)) {
      assert(
        !['Blocked', 'Recalled'].includes(batch.status as string),
        `BR-06 ${batch.public_code as string}`,
      );
      const a = actual[batch._key as string] ?? { massKg: item.mass_declared_kg as string };
      const massActual = mass3(a.massKg);
      const d = checkDiscrepancy({ declaredKg: item.mass_declared_kg as string, actualKg: massActual });
      assert('percent' in d, 'declared zero');
      assert(!d.actRequired || a.act, `BR-07 ${batch.public_code as string}: ${d.percent}% requires an act`);
      item.mass_actual_kg = massActual;
      item.discrepancy_act = a.act ?? null;
      this.transition(batch, 'Accepted', 'WAYBILL_ACCEPTED', this.user(userKey).id as string);
      batch.holder_org_id = org.id;
      batch.mass_kg = massActual;
    }
    this.end();
  }

  rejectWaybill(at: string, userKey: string, key: string, reason: string): void {
    this.begin('rejectWaybill', userKey, at);
    const org = this.requireRole(userKey, 'PROCESSOR', 'RETAILER');
    const w = this.waybill(key);
    assert(w.receiver_org_id === org.id, 'NOT_RECEIVER');
    assert(w.status === 'SENT', `waybill ${key} is ${w.status as string}`);
    this.touch('waybill', w);
    w.status = 'REJECTED';
    w.reject_reason = reason;
    w.version = (w.version as number) + 1;
    for (const { batch } of this.itemsOf(w)) {
      assert(batch.status === 'InTransit', 'recalled-in-transit rejection is not modelled');
      this.transition(batch, 'Approved', 'WAYBILL_REJECTED', this.user(userKey).id as string);
    }
    this.end();
  }

  createLabTest(at: string, userKey: string, key: string, batchKey: string, labKey: string): Row {
    this.begin('createLabTest', userKey, at);
    this.requireRole(userKey, 'INSPECTOR');
    const lab = this.org(labKey);
    assert(lab.type === 'LAB' && lab.status === 'ACTIVE', 'labOrg type');
    const t = this.newLabTest(key, this.batch(batchKey), lab, 'INSPECTOR', this.user(userKey).id as string);
    this.end();
    return t;
  }

  registerLabSample(at: string, userKey: string, key: string): void {
    this.begin('registerLabSample', userKey, at);
    const org = this.requireRole(userKey, 'LAB');
    const t = this.test(key);
    assert(t.lab_org_id === org.id, `lab test ${key} is not ${userKey}'s`);
    assert(t.status === 'QUEUED', `lab test ${key} is ${t.status as string}`);
    this.touch('labTest', t);
    t.status = 'SAMPLED';
    t.sampled_at = this.clock;
    t.version = (t.version as number) + 1;
    this.end();
  }

  private passingValue(testKey: string, indicatorKey: string, max: string): string {
    const pct = 8n + BigInt(hashInt(`${testKey}:${indicatorKey}`, 65));
    let v = (ms6(max) * pct) / 100n;
    if (v === 0n) v = 1n;
    return dec6(v);
  }

  submitLabResults(
    at: string,
    userKey: string,
    key: string,
    values: Record<string, string> = {},
    recallKey?: string,
  ): Row {
    this.begin('submitLabResults', userKey, at);
    const org = this.requireRole(userKey, 'LAB');
    const user = this.user(userKey);
    const t = this.test(key);
    assert(t.lab_org_id === org.id, `lab test ${key} is not ${userKey}'s`);
    assert(LAB_OPEN.has(t.status as string), `lab test ${key} is ${t.status as string}`);
    const b = this.batchById(t.batch_id);
    const norms = this.t.norms.filter((n) => n.product_id === b.product_id);
    assert(norms.length > 0, 'product has no norms');
    const results = norms.map((n) => {
      const ind = this.t.indicators.find((i) => i.id === n.indicator_id)!;
      const ik = [...this.keys.indicator.entries()].find(([, r]) => r === ind)![0];
      const value =
        values[ik] !== undefined ? dec6(ms6(values[ik]!)) : this.passingValue(key, ik, n.max_value as string);
      return { indicatorId: ind.id as string, value, maxValue: n.max_value as string };
    });
    for (const k of Object.keys(values))
      assert(
        norms.some((n) => n.indicator_id === this.keys.indicator.get(k)?.id),
        `no norm for ${k}`,
      );
    const concl = concludeLabTest({ results });
    assert('conclusion' in concl, 'no results');
    for (const r of results) {
      this.t.lab_results.push({
        id: uuid('lab_result', `${key}:${r.indicatorId}`),
        lab_test_id: t.id,
        indicator_id: r.indicatorId,
        value: r.value,
        norm_value_snapshot: r.maxValue,
        is_exceeded: compareDecimalStrings(r.value, r.maxValue) > 0,
      });
    }
    this.touch('labTest', t);
    t.status = 'DONE';
    t.conclusion = concl.conclusion;
    t.completed_at = this.clock;
    t.sampled_at = t.sampled_at ?? this.clock;
    t.version = (t.version as number) + 1;
    if (b.status === 'OnTest') {
      if (concl.conclusion === 'PASS') this.transition(b, 'Approved', 'LAB_PASS', user.id as string);
      else this.transition(b, 'Blocked', 'LAB_FAIL', user.id as string);
    }
    let recall: Row | null = null;
    if (concl.conclusion === 'FAIL') {
      assert(recallKey, `FAIL of ${key} needs a recall key`);
      recall = this.runRecallEngine(recallKey, b, {
        trigger: 'LAB',
        reason: RECALL_REASON_LAB,
        blockUpstream: false,
        labTestId: t.id as string,
      });
      t.recall_id = recall.id;
    }
    this.end();
    const product = this.productById(b.product_id);
    const origin = b.origin_org_id as string;
    const holder = b.holder_org_id as string;
    this.notify(
      'LAB_RESULT',
      {
        orgs: holder && holder !== origin ? [origin, holder] : [origin],
        roles: ['INSPECTOR', 'COMPLAINT'].includes(t.reason as string) ? ['INSPECTOR'] : [],
      },
      {
        labTestId: t.id,
        batchId: b.id,
        publicCode: b.public_code,
        productName: product.name,
        conclusion: t.conclusion,
        recallId: t.recall_id,
      },
      this.clock,
    );
    this.recalculateRating(origin, this.clock);
    if (recall && this.pendingRecallEvents.length) this.flushRecallEvents();
    return t;
  }

  uploadLabProtocol(at: string, userKey: string, key: string): void {
    this.begin('uploadLabProtocol', userKey, at);
    const org = this.requireRole(userKey, 'LAB');
    const t = this.test(key);
    assert(t.lab_org_id === org.id, `lab test ${key} is not ${userKey}'s`);
    const id = this.addFile({
      key: `protocol:${key}`,
      kind: 'LAB_PROTOCOL',
      originalName: `protocol-${this.batchById(t.batch_id).public_code as string}.pdf`,
      ownerId: this.user(userKey).id as string,
      createdAt: this.clock,
      source: { type: 'protocol', testId: t.id as string },
    });
    this.touch('labTest', t);
    t.protocol_file_id = id;
    this.created(
      'file',
      this.t.files.find((f) => f.id === id)!,
    );
    this.end();
  }

  private escalateLabTest(t: Row, tick: string): void {
    this.begin('system.labTestEscalate', null, tick, true);
    this.touch('labTest', t);
    t.status = 'ESCALATED';
    t.escalated_at = this.clock;
    t.version = (t.version as number) + 1;
    this.end();
    const b = this.batchById(t.batch_id);
    const lab = this.orgById(t.lab_org_id);
    this.notify(
      'LAB_OVERDUE',
      { orgHeads: [lab.id as string], roles: ['INSPECTOR'] },
      {
        labTestId: t.id,
        batchId: b.id,
        publicCode: b.public_code,
        labOrgId: lab.id,
        labName: lab.name,
        dueAt: t.due_at,
      },
      this.clock,
    );
  }

  private pendingRecallEvents: (() => void)[] = [];

  private flushRecallEvents(): void {
    const events = this.pendingRecallEvents;
    this.pendingRecallEvents = [];
    for (const e of events) e();
  }

  traverse(sourceId: unknown, direction: 'DOWN' | 'UP'): Map<string, number> {
    const found = new Map<string, number>();
    let frontier = [sourceId as string];
    for (let depth = 1; depth <= 20 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const l of this.t.batch_links) {
          const [from, to] =
            direction === 'DOWN'
              ? [l.parent_batch_id, l.child_batch_id]
              : [l.child_batch_id, l.parent_batch_id];
          if (from !== id) continue;
          const tid = to as string;
          if (tid === sourceId || found.has(tid)) continue;
          found.set(tid, depth);
          next.push(tid);
        }
      }
      frontier = next;
    }
    return found;
  }

  private runRecallEngine(
    key: string,
    source: Row,
    a: {
      trigger: 'LAB' | 'INSPECTOR' | 'COMPLAINT';
      reason: string;
      blockUpstream: boolean;
      labTestId?: string;
      complaintId?: string;
    },
  ): Row {
    const open = this.t.recalls.find((r) => r.source_batch_id === source.id && r.status === 'OPEN');
    if (open) return open;
    assert(!this.keys.recall.has(key), `duplicate recall key ${key}`);
    const op = this.op!;
    const recall: Row = {
      id: uuid('recall', key),
      source_batch_id: source.id,
      trigger: a.trigger,
      reason: a.reason,
      status: 'OPEN',
      block_upstream: a.blockUpstream,
      lab_test_id: a.labTestId ?? null,
      complaint_id: a.complaintId ?? null,
      opened_at: this.clock,
      closed_at: null,
      version: 1,
      created_at: this.clock,
      updated_at: this.clock,
      created_by: op.actorId,
      deleted_at: null,
      _key: key,
    };
    this.t.recalls.push(recall);
    this.keys.recall.set(key, recall);
    this.created('recall', recall);
    const members: { batch: Row; direction: 'SOURCE' | 'DOWN' | 'UP'; depth: number }[] = [
      { batch: source, direction: 'SOURCE', depth: 0 },
    ];
    for (const [id, depth] of this.traverse(source.id, 'DOWN'))
      members.push({ batch: this.batchById(id), direction: 'DOWN', depth });
    if (a.blockUpstream) {
      for (const [id, depth] of this.traverse(source.id, 'UP')) {
        if (!members.some((m) => m.batch.id === id))
          members.push({ batch: this.batchById(id), direction: 'UP', depth });
      }
    }
    const tasks: Row[] = [];
    const dueAt = recallTaskDueAt({ openedAt: this.clock }).dueAt;
    for (const m of members
      .filter((x) => x.batch.deleted_at === null)
      .sort((x, y) => ((x.batch.id as string) < (y.batch.id as string) ? -1 : 1))) {
      const before = m.batch.status as BatchStatus;
      this.t.recall_batches.push({
        id: uuid('recall_batch', `${key}:${m.batch._key as string}`),
        recall_id: recall.id,
        batch_id: m.batch.id,
        direction: m.direction,
        depth: m.depth,
        status_before: before,
      });
      if (['Processed', 'Sold', 'WrittenOff', 'Recalled'].includes(before)) continue;
      this.transition(m.batch, 'Recalled', 'RECALLED', op.actorId);
      let holder = m.batch.holder_org_id;
      if (before === 'InTransit') {
        const sent = this.t.waybills.find(
          (w) =>
            w.status === 'SENT' &&
            this.t.waybill_items.some((i) => i.waybill_id === w.id && i.batch_id === m.batch.id),
        );
        assert(sent, `no SENT waybill for in-transit ${m.batch.public_code as string}`);
        holder = sent.receiver_org_id;
      }
      const task: Row = {
        id: uuid('recall_task', `${key}:${m.batch._key as string}`),
        recall_id: recall.id,
        holder_org_id: holder,
        batch_id: m.batch.id,
        due_at: iso(dueAt),
        status: 'OPEN',
        confirmed_by: null,
        confirmed_at: null,
        escalated_at: null,
        version: 1,
        created_at: this.clock,
        updated_at: this.clock,
      };
      this.t.recall_tasks.push(task);
      this.created('recallTask', task);
      tasks.push(task);
    }
    const at = this.clock;
    const sourceOrigin = source.origin_org_id as string;
    const eventPayload = {
      recallId: recall.id,
      sourceBatchId: source.id,
      publicCode: source.public_code,
      trigger: recall.trigger,
    };
    if (shouldCloseRecall({ taskStatuses: tasks.map((x) => x.status as string) }).close) {
      recall.status = 'CLOSED';
      recall.closed_at = at;
      recall.version = 2;
      this.pendingRecallEvents.push(() =>
        this.notify('RECALL', { roles: ['INSPECTOR'] }, { ...eventPayload, event: 'CLOSED' }, at),
      );
    }
    this.pendingRecallEvents.push(() => {
      this.notify(
        'RECALL',
        {
          roles: ['INSPECTOR'],
          orgs: [...new Set(tasks.map((x) => x.holder_org_id as string)), sourceOrigin],
        },
        { ...eventPayload, event: 'OPENED' },
        at,
      );
      for (const task of tasks) {
        const b = this.batchById(task.batch_id);
        this.notify(
          'RECALL_TASK',
          { orgs: [task.holder_org_id as string] },
          {
            recallId: recall.id,
            taskId: task.id,
            batchId: b.id,
            publicCode: b.public_code,
            dueAt: task.due_at,
            event: 'CREATED',
          },
          at,
        );
      }
      this.recalculateRating(sourceOrigin, this.async(at, 1));
    });
    return recall;
  }

  private escalateRecallTask(task: Row, tick: string): void {
    this.begin('system.recallTaskOverdue', null, tick, true);
    this.touch('recallTask', task);
    task.status = 'OVERDUE';
    task.escalated_at = this.clock;
    task.version = (task.version as number) + 1;
    this.end();
    const b = this.batchById(task.batch_id);
    const holder = this.orgById(task.holder_org_id);
    this.notify(
      'OVERDUE',
      { orgs: [holder.id as string], roles: ['INSPECTOR'] },
      {
        recallId: task.recall_id,
        taskId: task.id,
        batchId: b.id,
        publicCode: b.public_code,
        dueAt: task.due_at,
        holderOrgId: holder.id,
        holderName: holder.name,
      },
      this.clock,
    );
  }

  confirmRecallTask(at: string, userKey: string, recallKey: string, batchKey: string): void {
    this.begin('confirmRecallTask', userKey, at);
    const org = this.requireRole(userKey, 'FARMER', 'PROCESSOR', 'RETAILER');
    const task = this.task(recallKey, batchKey);
    const recall = this.recall(recallKey);
    assert(task.holder_org_id === org.id, `task of ${batchKey} is not ${userKey}'s`);
    assert(
      task.status === 'OPEN' || task.status === 'OVERDUE',
      `task ${batchKey} is ${task.status as string}`,
    );
    const b = this.batch(batchKey);
    this.transition(b, 'WrittenOff', 'WRITTEN_OFF', this.user(userKey).id as string);
    this.touch('recallTask', task);
    task.status = 'CONFIRMED';
    task.confirmed_at = this.clock;
    task.confirmed_by = this.user(userKey).id;
    task.version = (task.version as number) + 1;
    const statuses = this.t.recall_tasks
      .filter((x) => x.recall_id === recall.id)
      .map((x) => x.status as string);
    let closed = false;
    if (shouldCloseRecall({ taskStatuses: statuses }).close) {
      this.touch('recall', recall);
      recall.status = 'CLOSED';
      recall.closed_at = this.clock;
      recall.version = (recall.version as number) + 1;
      closed = true;
    }
    this.end();
    if (closed) {
      const source = this.batchById(recall.source_batch_id);
      this.notify(
        'RECALL',
        { roles: ['INSPECTOR'] },
        {
          recallId: recall.id,
          event: 'CLOSED',
          sourceBatchId: source.id,
          publicCode: source.public_code,
          trigger: recall.trigger,
        },
        this.clock,
      );
    }
  }

  createPublicComplaint(
    at: string,
    key: string,
    batchKey: string,
    text: string,
    contact: string | null,
    ip: string,
  ): Row {
    this.begin('createPublicComplaint', null, at);
    const b = this.batch(batchKey);
    assert([...text].length >= 10, 'complaint text too short');
    const row: Row = {
      id: uuid('complaint', key),
      batch_id: b.id,
      text,
      contact,
      status: 'NEW',
      decision: null,
      decision_comment: null,
      inspector_id: null,
      lab_test_id: null,
      recall_id: null,
      decided_at: null,
      ip,
      created_at: this.clock,
      updated_at: this.clock,
      deleted_at: null,
      _key: key,
    };
    this.t.complaints.push(row);
    this.keys.complaint.set(key, row);
    this.created('complaint', row);
    this.end();
    this.notify(
      'COMPLAINT',
      { roles: ['INSPECTOR'] },
      {
        complaintId: row.id,
        batchId: b.id,
        publicCode: b.public_code,
        productName: this.productById(b.product_id).name,
      },
      this.clock,
    );
    return row;
  }

  startComplaintReview(at: string, userKey: string, key: string): void {
    this.begin('startComplaintReview', userKey, at);
    this.requireRole(userKey, 'INSPECTOR');
    const c = this.complaint(key);
    assert(c.status === 'NEW', `complaint ${key} is ${c.status as string}`);
    this.touch('complaint', c);
    c.status = 'IN_REVIEW';
    c.inspector_id = this.user(userKey).id;
    this.end();
  }

  decideComplaint(
    at: string,
    userKey: string,
    key: string,
    d:
      | { decision: 'REJECT'; comment: string }
      | { decision: 'LAB_TEST'; comment: string; lab: string; testKey: string }
      | { decision: 'RECALL'; comment: string; recallKey: string; blockUpstream?: boolean },
  ): void {
    this.begin('decideComplaint', userKey, at);
    this.requireRole(userKey, 'INSPECTOR');
    const c = this.complaint(key);
    assert(c.status === 'NEW' || c.status === 'IN_REVIEW', `complaint ${key} is ${c.status as string}`);
    this.touch('complaint', c);
    c.status = 'DECIDED';
    c.decision = d.decision;
    c.decision_comment = d.comment;
    c.inspector_id = this.user(userKey).id;
    c.decided_at = this.clock;
    const b = this.batchById(c.batch_id);
    if (d.decision === 'LAB_TEST') {
      const lab = this.org(d.lab);
      assert(lab.type === 'LAB' && lab.status === 'ACTIVE', 'labOrg type');
      c.lab_test_id = this.newLabTest(d.testKey, b, lab, 'COMPLAINT', this.user(userKey).id as string).id;
    }
    if (d.decision === 'RECALL') {
      const recall = this.runRecallEngine(d.recallKey, b, {
        trigger: 'COMPLAINT',
        reason: d.comment,
        blockUpstream: d.blockUpstream ?? false,
        complaintId: c.id as string,
      });
      c.recall_id = recall.id;
    }
    this.end();
    this.flushRecallEvents();
  }

  createRecall(
    at: string,
    userKey: string,
    key: string,
    batchKey: string,
    reason: string,
    blockUpstream: boolean,
  ): Row {
    this.begin('createRecall', userKey, at);
    this.requireRole(userKey, 'INSPECTOR');
    const b = this.batch(batchKey);
    assert(b.deleted_at === null, `batch ${batchKey} is deleted`);
    const recall = this.runRecallEngine(key, b, { trigger: 'INSPECTOR', reason, blockUpstream });
    this.end();
    this.flushRecallEvents();
    return recall;
  }

  finish(): void {
    this.advance(this.seedNow);
    const now = Date.parse(this.seedNow);
    for (const t of this.t.lab_tests) {
      if (t.status === 'QUEUED' || t.status === 'SAMPLED')
        assert(Date.parse(t.due_at as string) >= now, `lab test ${t._key as string} is overdue`);
    }
    for (const t of this.t.recall_tasks) {
      if (t.status === 'OPEN')
        assert(Date.parse(t.due_at as string) >= now, `recall task ${t.id as string} is overdue`);
    }
    for (const table of Object.values(this.t)) {
      for (const r of table) {
        for (const [k, v] of Object.entries(r)) {
          if (typeof v === 'string' && /_at$/.test(k) && k !== 'due_at')
            assert(Date.parse(v) <= now, `${k} after SEED_NOW`);
        }
      }
    }
    for (const org of this.t.organizations) {
      if (org.type === 'FARM')
        assert(
          org.trust_rating === this.foldRating(org.id),
          `rating of ${org.name as string} is not the fold`,
        );
    }
    for (const b of this.t.batches) {
      const h = this.t.batch_status_history.filter((x) => x.batch_id === b.id);
      assert(h.length === b.version, `version of ${b.public_code as string} ≠ history length`);
      assert(
        h[h.length - 1]!.to_status === b.status,
        `history of ${b.public_code as string} does not end in its status`,
      );
    }
  }
}
