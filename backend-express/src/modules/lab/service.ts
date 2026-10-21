/**
 * Lab tests (contracts/openapi/paths/lab.yaml; БП-2, FR-QA-02…05, BR-02, R47, R57): the queue, the inspector's
 * unplanned test, sample registration, results (BR-02 conclusion; PASS → Approved, FAIL → Blocked and the recall
 * engine, modules/recalls/engine.ts), the PDF protocol. Visibility and views — view.ts.
 *
 * Mutations of a test lock it first (`labTest`, R52), then — submitLabResults only — the batches `ORDER BY id`; every
 * check from 404 on runs over the locked test; `If-Match` is compared with its version. A LAB mutation sees only the
 * tests of the user's own laboratory (anything else is 404). submitLabResults runs at REPEATABLE READ like the
 * recall engine (п. 8.2.3) and is repeated once on 40001/40P01 or the open-recall race.
 */
import { sql, type Transaction } from 'kysely';
import type { Request } from 'express';
import { compareDecimalStrings, concludeLabTest } from '@agrotrace/domain';
import { LabResultsInputSchema, LabSampleRequestSchema, LabTestCreateSchema } from '@agrotrace/validation';
import type { Container } from '../../container.js';
import { lockBatches } from '../../db/locks.js';
import { txNow, withTx } from '../../db/tx.js';
import type { DB } from '../../db/types.generated.js';
import { parseBody } from '../../http/body.js';
import { checkVersion, type IfMatch } from '../../http/if-match.js';
import type { UploadedFile } from '../../http/multipart.js';
import { dayAfter, QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import { enqueue } from '../../infra/outbox.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { notify, transitionBatch } from '../batches/lifecycle.js';
import { invalidTransition } from '../batches/service.js';
import { iso } from '../batches/view.js';
import { seesAll } from '../batches/visibility.js';
import {
  fileAuditView,
  fileRef,
  insertFile,
  prepareUpload,
  softDeleteFile,
  storeObjects,
  type FileRef,
} from '../files/service.js';
import { insertUnplannedLabTest } from './assign.js';
import { dropPublicPages } from '../public/cache.js';
import {
  applyRecall,
  findOpenRecall,
  recallScope,
  RECALL_TX,
  type LockedBatch,
  type ScopeMember,
} from '../recalls/engine.js';
import {
  currentNorms,
  LAB_OPEN,
  labTestVisibleTo,
  loadLabTest,
  loadLabTestItems,
  type LabTestView,
} from './view.js';

type Tx = Transaction<DB>;

/** uploadLabProtocol: PDF ≤ 10 MiB inclusive (FR-QA-04, spec 8.6). */
export const PROTOCOL_MAX_BYTES = 10 * 1024 * 1024;
/** submitLabResults FAIL: `recalls.reason` (contract submitLabResults). */
export const LAB_RECALL_REASON = 'Превышение нормативов по результатам лабораторного анализа';

const LIST_SORT = { fields: ['dueAt', 'createdAt', 'completedAt'], default: 'dueAt,asc' } as const;
const STATUSES = ['QUEUED', 'SAMPLED', 'DONE', 'ESCALATED', 'CANCELLED'] as const;
const REASONS = ['PLANNED', 'RISK', 'COMPLAINT', 'INSPECTOR'] as const;

const notFound = () => new AppProblem(404, 'NOT_FOUND');

const labTestAudit = (t: {
  status: string;
  conclusion: string | null;
  sampled_at: unknown;
  completed_at: unknown;
  recall_id: string | null;
  version: number;
}) => ({
  status: t.status,
  conclusion: t.conclusion,
  sampledAt: t.sampled_at ? iso(t.sampled_at) : null,
  completedAt: t.completed_at ? iso(t.completed_at) : null,
  recallId: t.recall_id,
  version: t.version,
});

export function labService(c: Container) {
  const { db } = c;

  /** The non-deleted test of the user's own laboratory, locked `FOR NO KEY UPDATE` (R52 `labTest`); else 404. */
  async function lockOwnTest(tx: Tx, p: Principal, id: string) {
    const t = await tx
      .selectFrom('lab_tests')
      .selectAll()
      .where('id', '=', id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!t || t.deleted_at !== null || !p.roles.includes('LAB') || t.lab_org_id !== p.orgId) throw notFound();
    const b = await tx
      .selectFrom('batches')
      .select('deleted_at')
      .where('id', '=', t.batch_id)
      .executeTakeFirst();
    if (!b || b.deleted_at !== null) throw notFound();
    return t;
  }

  async function currentVersion(id: string) {
    const r = await db.selectFrom('lab_tests').select('version').where('id', '=', id).executeTakeFirst();
    return r ? { currentVersion: r.version } : undefined;
  }

  /** Whether `p` sees the test (tag Lab); 404 otherwise. */
  async function visibleTest(p: Principal, id: string): Promise<void> {
    const r = await db
      .selectFrom('lab_tests as t')
      .innerJoin('batches as b', 'b.id', 't.batch_id')
      .select('t.id')
      .where('t.id', '=', id)
      .where('t.deleted_at', 'is', null)
      .where('b.deleted_at', 'is', null)
      .where(labTestVisibleTo(p))
      .executeTakeFirst();
    if (!r) throw notFound();
  }

  const view = (p: Principal, id: string) => loadLabTest(db, p, c.fileUrls, id);

  return {
    /** listLabTests — visible tests, filters joined by AND (R51 for labOrgId), `x-sort`. */
    async list(p: Principal, query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(LIST_SORT);
      const text = q.q();
      const statuses = q.enumList('status', STATUSES);
      const reasons = q.enumList('reason', REASONS);
      const conclusion = q.enumOf('conclusion', ['PASS', 'FAIL'] as const);
      const overdue = q.bool('overdue');
      const batchId = q.uuid('batchId');
      let labOrgId: string | undefined;
      if (seesAll(p)) labOrgId = q.uuid('labOrgId');
      else q.notAllowed('labOrgId');
      const { from, to } = q.dateRange();
      q.done();

      const overdueSql = sql<boolean>`(t.status IN ('QUEUED', 'SAMPLED', 'ESCALATED') AND now() > t.due_at)`;
      let base = db
        .selectFrom('lab_tests as t')
        .innerJoin('batches as b', 'b.id', 't.batch_id')
        .where('t.deleted_at', 'is', null)
        .where('b.deleted_at', 'is', null)
        .where(labTestVisibleTo(p));
      if (statuses) base = base.where('t.status', 'in', statuses);
      if (reasons) base = base.where('t.reason', 'in', reasons);
      if (conclusion) base = base.where('t.conclusion', '=', conclusion);
      if (overdue !== undefined) base = base.where(overdue ? overdueSql : sql<boolean>`NOT ${overdueSql}`);
      if (batchId) base = base.where('t.batch_id', '=', batchId.toLowerCase());
      if (labOrgId) base = base.where('t.lab_org_id', '=', labOrgId.toLowerCase());
      // from/to — by the UTC date of createdAt (sessions run in UTC; bounds are UTC midnights).
      if (from) base = base.where('t.created_at', '>=', new Date(`${from}T00:00:00Z`));
      if (to) base = base.where('t.created_at', '<', dayAfter(to));
      if (text !== undefined)
        base = base.where(sql<boolean>`position(lower(${text}) in lower(b.public_code)) > 0`);
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const order = {
        dueAt: sql`t.due_at`,
        createdAt: sql`t.created_at`,
        completedAt: sql`t.completed_at`,
      }[sort.field as (typeof LIST_SORT.fields)[number]];
      const rows = await base
        .select('t.id')
        .orderBy(sort.dir === 'asc' ? sql`${order} ASC NULLS LAST` : sql`${order} DESC NULLS LAST`)
        .orderBy(sql`t.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      return {
        items: await loadLabTestItems(
          db,
          rows.map((r) => r.id),
        ),
        page,
        size,
        total: Number(total),
      };
    },

    async get(p: Principal, id: string): Promise<LabTestView> {
      await visibleTest(p, id);
      return view(p, id);
    },

    /**
     * createLabTest — body → references in one 400 (batch non-deleted; organization non-deleted ACTIVE, of type
     * LAB) → a QUEUED INSPECTOR test due in 5 working days, LAB_ASSIGNED (lab + batch origin). No locks: no existing
     * row changes.
     */
    async create(p: Principal, body: unknown): Promise<LabTestView> {
      const input = parseBody(LabTestCreateSchema, body);
      const batchId = input.batchId.toLowerCase();
      const labOrgId = input.labOrgId.toLowerCase();
      const id = await withTx(db, async (tx) => {
        const errors: Record<string, string[]> = {};
        const b = await tx
          .selectFrom('batches as b')
          .innerJoin('products as pr', 'pr.id', 'b.product_id')
          .select(['b.id', 'b.public_code', 'b.origin_org_id', 'pr.name as product_name'])
          .where('b.id', '=', batchId)
          .where('b.deleted_at', 'is', null)
          .executeTakeFirst();
        if (!b) errors.batchId = ['validation.notFound'];
        const lab = await tx
          .selectFrom('organizations')
          .select(['id', 'name', 'type', 'status'])
          .where('id', '=', labOrgId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!lab || lab.status !== 'ACTIVE') errors.labOrgId = ['validation.notFound'];
        else if (lab.type !== 'LAB') errors.labOrgId = ['validation.labOrg.type'];
        if (Object.keys(errors).length > 0) throw validationProblem(errors);

        const t = await insertUnplannedLabTest(tx, {
          batch: b!,
          lab: lab!,
          reason: 'INSPECTOR',
          actorId: p.userId,
          action: 'createLabTest',
        });
        return t.id;
      });
      return view(p, id);
    },

    /** registerLabSample — body/If-Match (400) → lock → 404 → If-Match → QUEUED → SAMPLED, sampledAt, version + 1. */
    async sample(p: Principal, id: string, ifMatch: IfMatch, body: unknown): Promise<LabTestView> {
      parseBody(LabSampleRequestSchema, body ?? {}, [], { extraErrors: ifMatch.errors });
      const version = ifMatch.version!;
      await withTx(
        db,
        async (tx) => {
          const t = await lockOwnTest(tx, p, id);
          checkVersion(version, t.version);
          if (t.status !== 'QUEUED') throw invalidTransition({ from: t.status, to: 'SAMPLED' });
          const after = await tx
            .updateTable('lab_tests')
            .set({ status: 'SAMPLED', sampled_at: sql`now()`, version: t.version + 1 })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'registerLabSample',
            entityType: 'labTest',
            entityId: id,
            diff: auditDiff(labTestAudit(t), labTestAudit(after)),
          });
        },
        { conflictParams: () => currentVersion(id) },
      );
      return view(p, id);
    },

    /**
     * submitLabResults — body/If-Match (400) → lock the test → 404 → If-Match → status → indicator set (one 400) →
     * lock the batch (PASS) or the batch and the recall scope (FAIL) → results, DONE, the batch transition (only from
     * OnTest), FAIL: the recall engine (new or the OPEN one, R57) → LAB_RESULT, rating.recalculate (FARM origin).
     */
    async submit(p: Principal, id: string, ifMatch: IfMatch, body: unknown): Promise<LabTestView> {
      // A repeated indicator is step 5 (after 404/If-Match/status), not a schema error (P36).
      const input = parseBody(LabResultsInputSchema, body, [], {
        deferDuplicates: ['results'],
        extraErrors: ifMatch.errors,
      });
      const version = ifMatch.version!;
      const codes = await withTx(
        db,
        async (tx) => {
          const t = await lockOwnTest(tx, p, id);
          checkVersion(version, t.version);
          if (!(LAB_OPEN as readonly string[]).includes(t.status))
            throw invalidTransition({ from: t.status, to: 'DONE' });

          // 5. The exact indicator set of the test's norms (D4) — duplicates and mismatch in one 400.
          const batch0 = await tx
            .selectFrom('batches as b')
            .innerJoin('products as pr', 'pr.id', 'b.product_id')
            .innerJoin('organizations as o', 'o.id', 'b.origin_org_id')
            .select(['b.product_id', 'pr.name as product_name', 'o.type as origin_type'])
            .where('b.id', '=', t.batch_id)
            .executeTakeFirstOrThrow();
          const norms = await currentNorms(tx, batch0.product_id);
          const normOf = new Map(norms.map((n) => [n.indicatorId, n]));
          const ids = input.results.map((r) => r.indicatorId.toLowerCase());
          const errors: Record<string, string[]> = {};
          const seen = new Set<string>();
          ids.forEach((x, i) => {
            if (seen.has(x)) errors[`results[${i}].indicatorId`] = ['validation.duplicate'];
            seen.add(x);
          });
          if (seen.size !== normOf.size || [...seen].some((x) => !normOf.has(x)))
            errors.results = ['validation.results.mismatch'];
          if (Object.keys(errors).length > 0) throw validationProblem(errors);

          const rows = input.results.map((r, i) => ({
            indicatorId: ids[i]!,
            value: r.value,
            maxValue: normOf.get(ids[i]!)!.maxValue,
          }));
          const concluded = concludeLabTest({ results: rows });
          if ('error' in concluded) throw new Error('concludeLabTest: no results'); // unreachable: minItems 1
          const conclusion = concluded.conclusion;

          // Locks of the batches (R52): the test's batch, plus — FAIL without an OPEN recall — the recall scope.
          const open = conclusion === 'FAIL' ? await findOpenRecall(tx, t.batch_id) : undefined;
          const scope: ScopeMember[] =
            conclusion === 'FAIL' && !open ? await recallScope(tx, t.batch_id, false) : [];
          const locked = await lockBatches(tx, [t.batch_id, ...scope.map((m) => m.batchId)]);
          const lockedMap = new Map<string, LockedBatch>(locked.map((b) => [b.id, b]));
          const b = locked.find((x) => x.id === t.batch_id)!;

          await tx
            .insertInto('lab_results')
            .values(
              rows.map((r) => ({
                lab_test_id: id,
                indicator_id: r.indicatorId,
                value: r.value,
                norm_value_snapshot: r.maxValue,
                is_exceeded: compareDecimalStrings(r.value, r.maxValue) > 0,
              })),
            )
            .execute();
          // The batch page shows labSummary (R82): dropped after every result, whatever the batch status.
          const changed: string[] = [b.public_code];
          if (b.status === 'OnTest') {
            const to = conclusion === 'PASS' ? 'Approved' : 'Blocked';
            const v = await transitionBatch(
              tx,
              b,
              to,
              conclusion === 'PASS' ? 'LAB_PASS' : 'LAB_FAIL',
              p.userId,
            );
            await auditService.record(tx, {
              actorId: p.userId,
              action: 'submitLabResults',
              entityType: 'batch',
              entityId: b.id,
              diff: { status: [b.status, to], version: [b.version, v] },
            });
            lockedMap.set(b.id, { ...b, status: to, version: v });
          }
          let recallId: string | null = null;
          if (conclusion === 'FAIL') {
            if (open) recallId = open.id;
            else {
              const outcome = await applyRecall(
                tx,
                {
                  sourceBatchId: t.batch_id,
                  trigger: 'LAB',
                  reason: LAB_RECALL_REASON,
                  blockUpstream: false,
                  labTestId: id,
                  actorId: p.userId,
                  action: 'submitLabResults',
                },
                scope,
                lockedMap,
              );
              recallId = outcome.recallId;
              changed.push(...outcome.changedCodes);
            }
          }
          const after = await tx
            .updateTable('lab_tests')
            .set({
              status: 'DONE',
              conclusion,
              completed_at: sql`now()`,
              sampled_at: sql`coalesce(sampled_at, now())`,
              recall_id: recallId,
              version: t.version + 1,
            })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'submitLabResults',
            entityType: 'labTest',
            entityId: id,
            diff: {
              ...auditDiff(labTestAudit(t), labTestAudit(after)),
              results: [
                null,
                rows.map((r) => ({
                  indicatorId: r.indicatorId,
                  value: r.value,
                  normValue: r.maxValue,
                  isExceeded: compareDecimalStrings(r.value, r.maxValue) > 0,
                })),
              ],
            },
          });
          const holder = b.holder_org_id;
          await notify(
            tx,
            'LAB_RESULT',
            {
              orgIds: holder && holder !== b.origin_org_id ? [b.origin_org_id, holder] : [b.origin_org_id],
              roles: t.reason === 'INSPECTOR' || t.reason === 'COMPLAINT' ? ['INSPECTOR'] : [],
            },
            {
              labTestId: id,
              batchId: b.id,
              publicCode: b.public_code,
              productName: batch0.product_name,
              conclusion,
              recallId,
            },
          );
          if (batch0.origin_type === 'FARM')
            await enqueue(tx, {
              type: 'rating.recalculate',
              payload: {
                organizationId: b.origin_org_id,
                cause: conclusion === 'PASS' ? 'LAB_PASS' : 'LAB_FAIL',
                sourceId: id,
              },
            });
          return changed;
        },
        { ...RECALL_TX, conflictParams: () => currentVersion(id) },
      );
      await dropPublicPages(c.redis, codes);
      return view(p, id);
    },

    /**
     * uploadLabProtocol — (413 by the reader) → 404 → 415 → the file, the test's protocol replaced (old file
     * soft-deleted; version unchanged), under the test's lock.
     */
    async uploadProtocol(p: Principal, id: string, upload: UploadedFile): Promise<FileRef> {
      await withTx(db, (tx) => lockOwnTest(tx, p, id));
      const file = await prepareUpload(upload, {
        kind: 'LAB_PROTOCOL',
        ownerId: p.userId,
        bucket: c.s3.bucket,
        allowed: ['application/pdf'],
      });
      await storeObjects(c.s3, file);
      await withTx(db, async (tx) => {
        const t = await lockOwnTest(tx, p, id);
        const now = await txNow(tx);
        await insertFile(tx, file);
        await tx
          .updateTable('lab_tests')
          .set({ protocol_file_id: file.row.id })
          .where('id', '=', id)
          .execute();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'uploadLabProtocol',
          entityType: 'file',
          entityId: file.row.id,
          diff: auditDiff(null, fileAuditView(file.row)),
        });
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'uploadLabProtocol',
          entityType: 'labTest',
          entityId: id,
          diff: { protocolFileId: [t.protocol_file_id, file.row.id] },
        });
        if (await softDeleteFile(tx, t.protocol_file_id, now))
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'uploadLabProtocol',
            entityType: 'file',
            entityId: t.protocol_file_id,
            diff: { deletedAt: [null, now.toISOString()] },
          });
      });
      return fileRef(c.fileUrls, {
        id: file.row.id,
        kind: 'LAB_PROTOCOL',
        mime: file.row.mime,
        size_bytes: String(file.row.size_bytes),
        original_name: file.row.original_name,
      });
    },

    /** downloadLabProtocol — the visible test's current protocol (404: invisible, none). */
    async protocolFile(p: Principal, id: string) {
      await visibleTest(p, id);
      const f = await db
        .selectFrom('lab_tests as t')
        .innerJoin('files as f', 'f.id', 't.protocol_file_id')
        .selectAll('f')
        .where('t.id', '=', id)
        .where('f.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!f) throw notFound();
      return f;
    },
  };
}
