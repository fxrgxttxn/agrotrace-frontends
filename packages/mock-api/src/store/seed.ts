import organizations from '@agrotrace/seed/data/organizations.json' with { type: 'json' };
import users from '@agrotrace/seed/data/users.json' with { type: 'json' };
import products from '@agrotrace/seed/data/products.json' with { type: 'json' };
import substances from '@agrotrace/seed/data/substances.json' with { type: 'json' };
import indicators from '@agrotrace/seed/data/indicators.json' with { type: 'json' };
import norms from '@agrotrace/seed/data/norms.json' with { type: 'json' };
import fields from '@agrotrace/seed/data/fields.json' with { type: 'json' };
import type { SeedData } from '@agrotrace/seed/src/data.js';
import { uuid } from '@agrotrace/seed/src/ids.js';
import { runScenario } from '@agrotrace/seed/src/scenario.js';
import { auditDiff as seedAuditDiff, World, type Row } from '@agrotrace/seed/src/world.js';
import type { MockConfig } from '../config.js';
import { iso } from '../lib/time.js';
import { SEED_IMAGES } from '../seed/assets.generated.js';
import { Store } from './store.js';
import type { FileRow, RoleCode, Tables, UserRow } from './types.js';

export const DEMO_PASSWORD = 'agrotrace-demo';

export const REGIONS: { code: string; name: string }[] = [
  { code: '33', name: 'Владимирская область' },
  { code: '50', name: 'Московская область' },
  { code: '37', name: 'Ивановская область' },
  { code: '52', name: 'Нижегородская область' },
  { code: '76', name: 'Ярославская область' },
  { code: '62', name: 'Рязанская область' },
];
const ROLES: RoleCode[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];

export const seedData = (): SeedData =>
  structuredClone({ organizations, users, products, substances, indicators, norms, fields }) as SeedData;

export interface SeedResult {
  store: Store;
}

export function buildSeed(cfg: MockConfig): SeedResult {
  const seedNow = iso(Math.floor(cfg.now() / 60_000) * 60_000);
  const regions = REGIONS.map((r) => ({ id: uuid('region', r.code), code: r.code }));
  const w = new World(
    seedData(),
    regions,
    ROLES.map((code, i) => ({ id: i + 1, code })),
    'agrotrace',
    cfg.publicBaseUrl,
    seedNow,
  );
  runScenario(w);

  const store = new Store(cfg.now);
  const t: Tables = store.t;
  t.regions = REGIONS.map((r) => ({ id: uuid('region', r.code), code: r.code, name: r.name }));

  const strip = <T>(r: Row): T => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) out[k] = v;
    return out as T;
  };

  const orgKeyById = new Map<string, string>();
  for (const [key, row] of w.keys.org) orgKeyById.set(row.id as string, key);
  for (const spec of w.files) {
    const s = spec.source;
    let row: FileRow;
    const base = {
      id: spec.id,
      kind: spec.kind,
      original_name: spec.originalName,
      owner_id: spec.ownerId,
      created_at: spec.createdAt,
      deleted_at: null,
    };
    if (s.type === 'productPhoto' || s.type === 'avatar') {
      const a = s.type === 'productPhoto' ? SEED_IMAGES.products[s.file] : SEED_IMAGES.avatars[s.name];
      if (!a) throw new Error(`no bundled image for ${JSON.stringify(s)}`);
      row = {
        ...base,
        mime: a.mime,
        size_bytes: a.size,
        sha256: a.sha256,
        variants: {
          '96': { sha256: a.variants[96].sha256, size: a.variants[96].size },
          '480': { sha256: a.variants[480].sha256, size: a.variants[480].size },
        },
        content: { type: 'asset', variants: { '96': a.variants[96].url, '480': a.variants[480].url } },
      };
    } else if (s.type === 'logo') {
      const a = SEED_IMAGES.logos[s.orgKey];
      if (!a) throw new Error(`no bundled logo for ${s.orgKey}`);
      row = { ...base, mime: 'image/svg+xml', size_bytes: a.size, sha256: a.sha256, variants: {}, content: { type: 'asset', url: a.url } };
    } else {
      row = {
        ...base,
        mime: s.type === 'qrPng' ? 'image/png' : 'application/pdf',
        size_bytes: 0,
        sha256: '',
        variants: {},
        content: { type: 'bytes', data: new Uint8Array(0) },
        regen:
          s.type === 'protocol'
            ? { type: 'protocol', testId: s.testId }
            : { type: s.type, batchId: w.t.batches.find((b) => b.public_code === s.publicCode)!.id as string },
      };
    }
    t.files.push(row);
    Object.assign(w.t.files.find((f) => f.id === spec.id)!, {
      bucket: 'agrotrace',
      object_key: `${spec.kind.toLowerCase()}/${spec.id}/original`,
      original_name: row.original_name,
      mime: row.mime,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      variants: row.variants,
      kind: row.kind,
      owner_id: row.owner_id,
      created_at: row.created_at,
      deleted_at: null,
    });
  }

  t.products = w.t.products.map((r) => strip(r));
  t.substances = w.t.substances.map((r) => strip(r));
  t.indicators = w.t.indicators.map((r) => strip(r));
  t.norms = w.t.norms.map((r) => strip(r));
  t.organizations = w.t.organizations.map((r) => strip(r));
  const rolesOf = new Map<string, RoleCode[]>();
  for (const ur of w.t.user_roles)
    (rolesOf.get(ur.user_id as string) ?? rolesOf.set(ur.user_id as string, []).get(ur.user_id as string)!).push(
      ROLES[(ur.role_id as number) - 1]!,
    );
  t.users = w.t.users.map((r) => {
    const u = strip<UserRow & { password_hash?: unknown }>(r);
    delete u.password_hash;
    const secret = cfg.totpUsers[u.email];
    return {
      ...u,
      password: DEMO_PASSWORD,
      roles: rolesOf.get(u.id) ?? [],
      totp_secret: secret ?? null,
      totp_enabled: secret !== undefined,
    };
  });
  t.fields = w.t.fields.map((r) => strip(r));
  t.treatments = w.t.treatments.map((r) => strip(r));
  t.batches = w.t.batches.map((r) => strip(r));
  t.batch_documents = w.t.batch_documents.map((r) => strip(r));
  t.batch_links = w.t.batch_links.map((r) => strip(r));
  t.batch_status_history = w.t.batch_status_history.map((r) => strip(r));
  t.waybills = w.t.waybills.map((r) => strip(r));
  t.waybill_items = w.t.waybill_items.map((r) => strip(r));
  t.lab_tests = w.t.lab_tests.map((r) => strip(r));
  t.lab_results = w.t.lab_results.map((r) => strip(r));
  t.recalls = w.t.recalls.map((r) => strip(r));
  t.recall_batches = w.t.recall_batches.map((r) => strip(r));
  t.recall_tasks = w.t.recall_tasks.map((r) => strip(r));
  t.complaints = w.t.complaints.map((r) => strip(r));

  const readBefore = Date.parse(seedNow) - 72 * 3_600_000;
  const byTime = w.notifications
    .map((n, i) => ({ n, i }))
    .sort((a, b) => Date.parse(a.n.at) - Date.parse(b.n.at) || a.i - b.i);
  let seq = 0;
  for (const { n } of byTime) {
    const user = t.users.find((u) => u.id === n.userId)!;
    seq += 1;
    t.notifications.push({
      id: uuid('notification', String(seq)),
      seq,
      user_id: n.userId,
      type: n.type,
      payload: n.payload,
      is_read: Date.parse(n.at) < readBefore,
      created_at: n.at,
    });
    if (user.notification_channels.email || n.forced) seq += 1;
    if (user.telegram_chat_id !== null && (user.notification_channels.telegram || n.forced)) seq += 1;
  }
  const auditByTime = w.audit.map((a, i) => ({ a, i })).sort((x, y) => Date.parse(x.a.at) - Date.parse(y.a.at) || x.i - y.i);
  t.audit_log = auditByTime.map(({ a }, i) => ({
    id: i + 1,
    actor_id: a.actorId,
    action: a.action,
    entity_type: a.entityType,
    entity_id: a.entityId,
    diff: seedAuditDiff(a.before, typeof a.after === 'function' ? a.after() : a.after) as Record<string, unknown>,
    ip: null,
    backend: 'seed',
    request_id: null,
    created_at: a.at,
  }));

  store.seq = {
    batch: t.batches.length,
    waybill: t.waybills.length,
    notification: seq,
    audit: t.audit_log.length,
    id: 0,
  };
  store.reindex();
  return { store };
}
