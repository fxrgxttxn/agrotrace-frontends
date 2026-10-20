/**
 * The public part (contracts/openapi/paths/public.yaml; FR-PUB-01…03, R30, R82, P9, P10), no authentication:
 *
 * - getPublicBatch — the PublicBatch of a non-deleted batch; cached in the shared Redis as `pub:batch:{publicCode}`
 *   (the exact JSON, EX 300): a hit is sent byte for byte, never parsed or re-serialized; the keys are deleted after
 *   the commit by every operation that changes the page (cache.ts). No personal data: organization names, region,
 *   dates, the lab summary and the status only.
 * - getCaptchaChallenge — an ALTCHA challenge (infra/altcha.ts), `Cache-Control: no-store`.
 * - createPublicComplaint — order: the `complaint-ip` limit (every request counts, RATE_LIMIT_OVERRIDES honoured) →
 *   the publicCode pattern and the body in one 400 → the ALTCHA solution (invalid, expired or already used →
 *   400 CAPTCHA_FAILED) → the batch (404; a solution is not used up by a 404) → the solution marked used
 *   (`altcha-used:{signature}` SET NX EX 600; a parallel replay loses here) → the complaint NEW, its audit row (no
 *   actor), COMPLAINT to the inspectors in the outbox.
 */
import { sql } from 'kysely';
import { PublicComplaintRequestSchema } from '@agrotrace/validation';
import type { Container } from '../../container.js';
import { withTx } from '../../db/tx.js';
import { parseBody } from '../../http/body.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import { hitRateLimit } from '../../http/rate-limit.js';
import {
  altchaKey,
  ALTCHA_TTL_SEC,
  createAltchaChallenge,
  verifyAltchaSolution,
} from '../../infra/altcha.js';
import { publicFileUrl } from '../../infra/file-urls.js';
import { auditDiff, auditService } from '../audit/service.js';
import { notify } from '../batches/lifecycle.js';
import { pathStages } from '../batches/path.js';
import { iso } from '../batches/view.js';

/** Contract `PublicCode` parameter. */
export const PUBLIC_CODE = /^AT-\d{4}-\d{6,}$/;
export const PAGE_TTL_SEC = 300;

/** SafetyStatus by the batch status (schema SafetyStatus). */
const SAFETY: Record<string, string> = {
  Recalled: 'RECALLED',
  WrittenOff: 'RECALLED',
  Blocked: 'BLOCKED',
  Created: 'UNKNOWN',
  OnTest: 'UNKNOWN',
};

const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const captchaFailed = () => new AppProblem(400, 'CAPTCHA_FAILED');
const notFound = () => new AppProblem(404, 'NOT_FOUND');

export function publicService(c: Container) {
  const { db, redis } = c;
  const key = altchaKey(c.config.JWT_SECRET);

  /** PublicBatch of the non-deleted batch with `code`, or undefined. */
  async function buildPage(code: string): Promise<Record<string, unknown> | undefined> {
    const b = await db
      .selectFrom('batches as b')
      .innerJoin('products as p', 'p.id', 'b.product_id')
      .innerJoin('organizations as o', 'o.id', 'b.origin_org_id')
      .innerJoin('regions as r', 'r.id', 'o.region_id')
      .select([
        'b.id',
        'b.public_code',
        'b.kind',
        'b.status',
        'b.origin_org_id',
        'b.harvested_at',
        'b.produced_at',
        'b.created_at',
        'p.name as product_name',
        'p.category as product_category',
        'p.image_file_id as product_image',
        'o.name as origin_name',
        'o.logo_file_id as origin_logo',
        'r.code as region_code',
        'r.name as region_name',
      ])
      .where('b.public_code', '=', code)
      .where('b.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!b) return undefined;
    const done = await db
      .selectFrom('lab_tests')
      .select(['id', 'conclusion', 'completed_at'])
      .where('batch_id', '=', b.id)
      .where('status', '=', 'DONE')
      .where('deleted_at', 'is', null)
      .where('completed_at', 'is not', null)
      .orderBy('completed_at')
      .orderBy(sql`id::text COLLATE "C"`)
      .execute();
    const last = done.at(-1);
    const path = await pathStages(db, b);
    return {
      publicCode: b.public_code,
      product: {
        name: b.product_name,
        category: b.product_category,
        imageUrl: b.product_image ? publicFileUrl(b.product_image) : null,
      },
      origin: {
        farmName: b.origin_name,
        logoUrl: b.origin_logo ? publicFileUrl(b.origin_logo) : null,
        region: { code: b.region_code, name: b.region_name },
      },
      harvestedAt: isoOrNull(b.harvested_at),
      producedAt: isoOrNull(b.produced_at),
      status: b.status,
      safety: SAFETY[b.status] ?? 'SAFE',
      path: path.map((s) => ({
        orgName: s.org.name,
        orgType: s.org.type,
        logoUrl: s.org.logoUrl,
        from: s.from,
        to: s.to,
      })),
      labSummary: {
        total: done.length,
        passed: done.filter((t) => t.conclusion === 'PASS').length,
        lastConclusion: last?.conclusion ?? null,
        lastDate: isoOrNull(last?.completed_at),
      },
    };
  }

  return {
    /** getPublicBatch — the page bytes (from the cache or freshly built and stored). */
    async page(code: string): Promise<Buffer> {
      if (!PUBLIC_CODE.test(code)) throw validationProblem({ publicCode: ['validation.pattern'] });
      const cacheKey = `pub:batch:${code}`;
      const hit = await redis.getBuffer(cacheKey);
      if (hit) return hit;
      const page = await buildPage(code);
      if (!page) throw notFound();
      const bytes = Buffer.from(JSON.stringify(page), 'utf8');
      await redis.set(cacheKey, bytes, 'EX', PAGE_TTL_SEC);
      return bytes;
    },

    captcha: () => createAltchaChallenge(key),

    /** createPublicComplaint (see the module comment for the order). */
    async complain(
      ip: string | null,
      code: string,
      body: unknown,
    ): Promise<{ id: string; createdAt: string }> {
      await hitRateLimit(redis, 'complaint-ip', ip ?? 'unknown', c.config.RATE_LIMIT_OVERRIDES);
      const codeErrors: Record<string, string[]> = PUBLIC_CODE.test(code)
        ? {}
        : { publicCode: ['validation.pattern'] };
      const input = parseBody(PublicComplaintRequestSchema, body, [], { extraErrors: codeErrors });
      const signature = verifyAltchaSolution(key, input.altcha);
      const usedKey = `altcha-used:${signature}`;
      if (!signature || (await redis.exists(usedKey)) === 1) throw captchaFailed();
      const b = await db
        .selectFrom('batches as b')
        .innerJoin('products as p', 'p.id', 'b.product_id')
        .select(['b.id', 'b.public_code', 'p.name as product_name'])
        .where('b.public_code', '=', code)
        .where('b.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!b) throw notFound();
      if ((await redis.set(usedKey, '1', 'EX', ALTCHA_TTL_SEC, 'NX')) !== 'OK') throw captchaFailed();
      return withTx(db, async (tx) => {
        const row = await tx
          .insertInto('complaints')
          .values({
            batch_id: b.id,
            text: input.text,
            contact: input.contact ?? null,
            status: 'NEW',
            ip,
          })
          .returning(['id', 'created_at'])
          .executeTakeFirstOrThrow();
        await auditService.record(tx, {
          actorId: null,
          action: 'createPublicComplaint',
          entityType: 'complaint',
          entityId: row.id,
          diff: auditDiff(null, {
            batchId: b.id,
            text: input.text,
            contact: input.contact ?? null,
            status: 'NEW',
          }),
        });
        await notify(
          tx,
          'COMPLAINT',
          { roles: ['INSPECTOR'] },
          { complaintId: row.id, batchId: b.id, publicCode: b.public_code, productName: b.product_name },
        );
        return { id: row.id, createdAt: iso(row.created_at) };
      });
    },
  };
}
