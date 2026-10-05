import { PublicComplaintRequestSchema } from '@agrotrace/validation';
import { compareCodePoints } from '@agrotrace/domain';
import { createChallenge, verifySolution } from '../domain/altcha.js';
import { CLIENT_IP, hitRateLimit } from '../domain/limits.js';
import { notify } from '../domain/notify.js';
import { parseBody } from '../http/body.js';
import { json, type Ctx, type Handler } from '../http/context.js';
import { ApiError, notFound, validation } from '../http/problem.js';
import type { Mock } from '../runtime.js';
import type { BatchRow } from '../store/types.js';
import { logoUrl, region } from '../views/refs.js';
import { pathSteps } from '../views/batches.js';

const SAFETY: Record<string, string> = {
  Recalled: 'RECALLED',
  WrittenOff: 'RECALLED',
  Blocked: 'BLOCKED',
  Created: 'UNKNOWN',
  OnTest: 'UNKNOWN',
};

function batchByCode(ctx: Ctx): BatchRow {
  const code = ctx.params.publicCode ?? '';
  if (!/^AT-\d{4}-\d{6,}$/.test(code)) throw validation({ publicCode: ['validation.pattern'] });
  const b = ctx.store.t.batches.find((x) => x.public_code === code && x.deleted_at === null);
  if (!b) throw notFound();
  return b;
}

export function publicBatch(m: Mock, b: BatchRow) {
  const s = m.store;
  const product = s.must('products', b.product_id);
  const origin = s.must('organizations', b.origin_org_id);
  const done = s.t.lab_tests
    .filter((t) => t.batch_id === b.id && t.deleted_at === null && t.status === 'DONE' && t.completed_at)
    .sort((x, y) => Date.parse(x.completed_at!) - Date.parse(y.completed_at!) || compareCodePoints(x.id, y.id));
  const last = done.at(-1);
  return {
    publicCode: b.public_code,
    product: { name: product.name, category: product.category, imageUrl: logoUrl(m, product.image_file_id) },
    origin: { farmName: origin.name, logoUrl: logoUrl(m, origin.logo_file_id), region: region(m, origin.region_id) },
    harvestedAt: b.harvested_at,
    producedAt: b.produced_at,
    status: b.status,
    safety: SAFETY[b.status] ?? 'SAFE',
    path: pathSteps(m, b).map((st) => ({ orgName: st.org.name, orgType: st.org.type, logoUrl: st.org.logoUrl, from: st.from, to: st.to })),
    labSummary: {
      total: done.length,
      passed: done.filter((t) => t.conclusion === 'PASS').length,
      lastConclusion: last?.conclusion ?? null,
      lastDate: last?.completed_at ?? null,
    },
  };
}

export const publicHandlers: Record<string, Handler> = {
  getPublicBatch: (ctx) => json(200, publicBatch(ctx, batchByCode(ctx))),

  async createPublicComplaint(ctx) {
    hitRateLimit(ctx, 'complaint-ip', CLIENT_IP);
    const code = ctx.params.publicCode ?? '';
    if (!/^AT-\d{4}-\d{6,}$/.test(code)) throw validation({ publicCode: ['validation.pattern'] });
    const input = parseBody(PublicComplaintRequestSchema, await ctx.json());
    const s = ctx.store;
    const signature = verifySolution(ctx.cfg.secret, input.altcha, s.now());
    if (!signature || s.kvGet(`altcha-used:${signature}`) !== undefined) throw new ApiError(400, 'CAPTCHA_FAILED');
    const b = batchByCode(ctx);
    s.kvSet(`altcha-used:${signature}`, '1', 600);
    const now = s.nowIso();
    const row = s.insert('complaints', {
      id: s.id('complaint'),
      batch_id: b.id,
      text: input.text,
      contact: input.contact ?? null,
      status: 'NEW',
      decision: null,
      decision_comment: null,
      inspector_id: null,
      lab_test_id: null,
      recall_id: null,
      decided_at: null,
      ip: CLIENT_IP,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    s.created('complaint', row);
    notify(s, 'COMPLAINT', { roles: ['INSPECTOR'] }, {
      complaintId: row.id,
      batchId: b.id,
      publicCode: b.public_code,
      productName: s.must('products', b.product_id).name,
    });
    return json(201, { id: row.id, createdAt: row.created_at });
  },

  getCaptchaChallenge: (ctx) => json(200, createChallenge(ctx.cfg.secret, ctx.store.now()), { 'Cache-Control': 'no-store' }),

  listPublicRegions: (ctx) =>
    json(
      200,
      [...ctx.store.t.regions]
        .sort((a, b) => compareCodePoints(a.name, b.name) || compareCodePoints(a.code, b.code))
        .map((r) => ({ code: r.code, name: r.name })),
    ),

  getHealthLive: () => json(200, { status: 'ok' }),
  getHealthReady: () => json(200, { status: 'ok', checks: { db: 'ok', redis: 'ok', rabbitmq: 'ok', s3: 'ok' } }),
};
