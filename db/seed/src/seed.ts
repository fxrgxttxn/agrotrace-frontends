import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { DEMO_PASSWORD, loadData } from './data.js';
import { renderFiles, type StoredObject } from './files.js';
import { withDeleteObjectsContentMd5 } from './s3-md5.js';
import { uuid } from './ids.js';
import { hashDemoPassword } from './passwords.js';
import { runScenario } from './scenario.js';
import { cmp, seedNowFrom } from './time.js';
import { auditDiff, World, type RegionRef, type Row } from './world.js';

export const KEPT_TABLES = ['roles', 'regions', 'schema_migrations'];
export const SEED_PREFIX = 'seed/';

export interface SeedEnv {
  databaseUrl: string;
  s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string };
  redisUrl: string | undefined;
  publicBaseUrl: string;
  seedNow: string;
  allowDb: string | undefined;
}

export function envFromProcess(e = process.env): SeedEnv {
  const need = (k: string): string => {
    const v = e[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    databaseUrl: need('DATABASE_URL'),
    s3: {
      endpoint: need('S3_ENDPOINT'),
      accessKey: need('S3_ACCESS_KEY'),
      secretKey: need('S3_SECRET_KEY'),
      bucket: need('S3_BUCKET'),
    },
    redisUrl: e.REDIS_URL || undefined,
    publicBaseUrl: e.PUBLIC_BASE_URL || 'http://react-express.localhost',
    seedNow: seedNowFrom(e.SEED_NOW),
    allowDb: e.SEED_ALLOW_DB || undefined,
  };
}

export function s3Client(env: SeedEnv): S3Client {
  return withDeleteObjectsContentMd5(
    new S3Client({
      endpoint: env.s3.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  );
}

export function buildWorld(
  regions: RegionRef[],
  roles: { id: number; code: string }[],
  bucket: string,
  publicBaseUrl: string,
  seedNow: string,
): World {
  const w = new World(loadData(), regions, roles, bucket, publicBaseUrl, seedNow);
  runScenario(w);
  return w;
}

const columnsOf = (rows: Row[]): string[] => {
  const cols: string[] = [];
  for (const r of rows)
    for (const k of Object.keys(r)) if (!k.startsWith('_') && !cols.includes(k)) cols.push(k);
  return cols;
};

const toParam = (v: unknown): unknown => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

async function insert(db: pg.ClientBase, table: string, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const cols = columnsOf(rows);
  const perChunk = Math.max(1, Math.floor(60000 / cols.length));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params: unknown[] = [];
    const values = chunk.map(
      (r) => `(${cols.map((c) => `$${params.push(toParam(r[c] ?? null))}`).join(',')})`,
    );
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}`, params);
  }
}

const stableByTime = <T>(items: T[], time: (x: T) => string): T[] =>
  items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => cmp(time(a.x), time(b.x)) || a.i - b.i)
    .map(({ x }) => x);

function notificationRows(w: World): Row[] {
  const rows: Row[] = [];
  const readBefore = Date.parse(w.seedNow) - 72 * 3_600_000;
  for (const n of stableByTime(w.notifications, (x) => x.at)) {
    const user = w.t.users.find((u) => u.id === n.userId)!;
    const channels = user.notification_channels as { email: boolean; telegram: boolean };
    const base = { user_id: n.userId, type: n.type, payload: n.payload, created_at: n.at };
    rows.push({
      ...base,
      channel: 'IN_APP',
      delivery_status: 'DELIVERED',
      attempts: 0,
      is_read: Date.parse(n.at) < readBefore,
    });
    if (channels.email || n.forced)
      rows.push({ ...base, channel: 'EMAIL', delivery_status: 'DELIVERED', attempts: 1, is_read: false });
    if (user.telegram_chat_id !== null && (channels.telegram || n.forced)) {
      rows.push({ ...base, channel: 'TELEGRAM', delivery_status: 'DELIVERED', attempts: 1, is_read: false });
    }
  }
  return rows.map((r, i) => ({ id: uuid('notification', String(i + 1)), ...r }));
}

function auditRows(w: World): Row[] {
  return stableByTime(w.audit, (a) => a.at).map((a) => {
    const after = typeof a.after === 'function' ? a.after() : a.after;
    return {
      actor_id: a.actorId,
      action: a.action,
      entity_type: a.entityType,
      entity_id: a.entityId,
      diff: auditDiff(a.before, after),
      ip: null,
      backend: 'seed',
      request_id: null,
      created_at: a.at,
    };
  });
}

function flushRedis(url: string): Promise<void> {
  const u = new URL(url);
  const db = u.pathname.replace('/', '') || '0';
  const pass = decodeURIComponent(u.password);
  const user = decodeURIComponent(u.username);
  const auth = pass ? (user && user !== 'default' ? [user, pass] : [pass]) : [];
  const cmd = (...args: string[]): string =>
    `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
  return new Promise((resolve, reject) => {
    const sock = connect(Number(u.port || 6379), u.hostname);
    let buf = '';
    sock.setTimeout(5000, () => sock.destroy(new Error('redis timeout')));
    sock.on('error', reject);
    sock.on('connect', () =>
      sock.write((auth.length ? cmd('AUTH', ...auth) : '') + cmd('SELECT', db) + cmd('FLUSHDB')),
    );
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('-')) return sock.destroy(new Error(`redis: ${buf.trim()}`));
      if ((buf.match(/\+OK\r\n/g) ?? []).length === (auth.length ? 3 : 2)) {
        sock.end();
        resolve();
      }
    });
  });
}

async function listKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function deleteKeys(s3: S3Client, bucket: string, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const r = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
    if (r.Errors?.length) throw new Error(`MinIO delete failed: ${JSON.stringify(r.Errors[0])}`);
  }
}

export function assertSeedableDb(env: SeedEnv): void {
  const name = decodeURIComponent(new URL(env.databaseUrl).pathname.replace(/^\//, ''));
  if (name !== 'agrotrace' && name !== env.allowDb) {
    throw new Error(`refusing to seed database "${name}": only "agrotrace" or SEED_ALLOW_DB=${name}`);
  }
}

export async function runSeed(
  env: SeedEnv = envFromProcess(),
  log: (s: string) => void = console.log,
): Promise<World> {
  assertSeedableDb(env);
  const db = new pg.Client({ connectionString: env.databaseUrl });
  await db.connect();
  try {
    const regions = (await db.query<RegionRef>('SELECT id, code FROM regions')).rows;
    const roles = (await db.query<{ id: number; code: string }>('SELECT id, code FROM roles')).rows;
    const w = buildWorld(regions, roles, env.s3.bucket, env.publicBaseUrl, env.seedNow);
    for (const u of w.t.users) u.password_hash = await hashDemoPassword(u.email as string, DEMO_PASSWORD);
    const objects: StoredObject[] = await renderFiles(w, env.s3.bucket);

    const old = await db.query<{ object_key: string; variants: Record<string, { key: string }> }>(
      'SELECT object_key, variants FROM files',
    );
    const oldKeys = old.rows.flatMap((f) => [
      f.object_key,
      ...Object.values(f.variants ?? {}).map((v) => v.key),
    ]);

    const s3 = s3Client(env);
    for (const o of objects) {
      await s3.send(
        new PutObjectCommand({ Bucket: env.s3.bucket, Key: o.key, Body: o.body, ContentType: o.contentType }),
      );
    }

    if (env.redisUrl) await flushRedis(env.redisUrl);

    await db.query('BEGIN');
    const tables = (
      await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename = ANY($1)) ORDER BY tablename`,
        [KEPT_TABLES],
      )
    ).rows.map((r) => r.tablename);
    await db.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    const t = w.t;
    await insert(db, 'files', t.files);
    await insert(db, 'products', t.products);
    await insert(db, 'substances', t.substances);
    await insert(db, 'indicators', t.indicators);
    await insert(db, 'norms', t.norms);
    await insert(db, 'organizations', t.organizations);
    await insert(db, 'users', t.users);
    await insert(db, 'user_roles', t.user_roles);
    await insert(db, 'fields', t.fields);
    await insert(db, 'treatments', t.treatments);
    await insert(db, 'batches', t.batches);
    await insert(db, 'batch_documents', t.batch_documents);
    await insert(db, 'batch_links', t.batch_links);
    await insert(
      db,
      'batch_status_history',
      stableByTime(t.batch_status_history, (h) => h.changed_at as string),
    );
    await insert(db, 'waybills', t.waybills);
    await insert(db, 'waybill_items', t.waybill_items);
    await insert(
      db,
      'lab_tests',
      t.lab_tests.map((x) => ({ ...x, recall_id: null })),
    );
    await insert(db, 'lab_results', t.lab_results);
    await insert(
      db,
      'recalls',
      t.recalls.map((x) => ({ ...x, complaint_id: null })),
    );
    await insert(db, 'complaints', t.complaints);
    await insert(db, 'recall_batches', t.recall_batches);
    await insert(db, 'recall_tasks', t.recall_tasks);
    await db.query('ALTER TABLE lab_tests DISABLE TRIGGER t_lab_tests_touch');
    await db.query('ALTER TABLE recalls DISABLE TRIGGER t_recalls_touch');
    for (const x of t.lab_tests.filter((r) => r.recall_id))
      await db.query('UPDATE lab_tests SET recall_id = $1 WHERE id = $2', [x.recall_id, x.id]);
    for (const x of t.recalls.filter((r) => r.complaint_id))
      await db.query('UPDATE recalls SET complaint_id = $1 WHERE id = $2', [x.complaint_id, x.id]);
    await db.query('ALTER TABLE lab_tests ENABLE TRIGGER t_lab_tests_touch');
    await db.query('ALTER TABLE recalls ENABLE TRIGGER t_recalls_touch');
    await insert(db, 'notifications', notificationRows(w));
    await insert(db, 'audit_log', auditRows(w));
    await db.query(`SELECT setval('batch_code_seq', $1)`, [t.batches.length]);
    await db.query(`SELECT setval('waybill_number_seq', $1)`, [t.waybills.length]);
    await db.query('COMMIT');

    const fresh = new Set(objects.map((o) => o.key));
    const stale = [...new Set([...oldKeys, ...(await listKeys(s3, env.s3.bucket, SEED_PREFIX))])].filter(
      (k) => !fresh.has(k),
    );
    await deleteKeys(s3, env.s3.bucket, stale);

    log(
      `seed: ${t.organizations.length} organizations, ${t.users.length} users, ${t.batches.length} batches, ` +
        `${t.waybills.length} waybills, ${t.lab_tests.length} lab tests, ${t.recalls.length} recalls, ` +
        `${t.files.length} files (${objects.length} objects), ${w.notifications.length} notifications; now ${w.seedNow}`,
    );
    return w;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await db.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runSeed().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
