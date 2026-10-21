/**
 * Complaints (contracts/openapi/paths/complaints.yaml; БП-6, FR-QA-08; entity-state-machines.json `complaint`), only
 * INSPECTOR: the list, the card (with the buyer's contact), review (NEW → IN_REVIEW) and the final decision
 * (NEW | IN_REVIEW → DECIDED): REJECT; LAB_TEST — an unplanned test like createLabTest with reason COMPLAINT in
 * `labOrgId` (lab/assign.ts); RECALL — the recall engine (trigger COMPLAINT, reason = comment, complaintId; an OPEN
 * recall of the batch is reused) at REPEATABLE READ.
 *
 * Locks (R47, R52): the complaint `FOR NO KEY UPDATE` first; RECALL then the batches in one `FOR NO KEY UPDATE ORDER BY id` (the
 * engine, step 3). Every check from 404 on runs over the locked complaint.
 */
import { sql, type Transaction } from 'kysely';
import type { Request } from 'express';
import { ComplaintDecisionSchema, ComplaintReviewRequestSchema } from '@agrotrace/validation';
import states from '../../../../contracts/rules/entity-state-machines.json' with { type: 'json' };
import type { Container } from '../../container.js';
import { withTx } from '../../db/tx.js';
import type { DB } from '../../db/types.generated.js';
import { parseBody } from '../../http/body.js';
import { dayAfter, QueryReader } from '../../http/params.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { invalidTransition } from '../batches/service.js';
import { iso, loadListItems, type BatchListItem } from '../batches/view.js';
import { insertUnplannedLabTest } from '../lab/assign.js';
import { dropPublicPages } from '../public/cache.js';
import { RECALL_TX, startRecall } from '../recalls/engine.js';
import { actorRefs, type ActorRef } from '../recalls/view.js';

type Tx = Transaction<DB>;

const SORT = { fields: ['createdAt', 'decidedAt'], default: 'createdAt,desc' } as const;
const STATUSES = ['NEW', 'IN_REVIEW', 'DECIDED'] as const;
const DECISIONS = ['REJECT', 'LAB_TEST', 'RECALL'] as const;

const canComplaintGo = (from: string, to: string): boolean =>
  states.complaint.transitions.some((t) => t.from === from && t.to === to);

const notFound = () => new AppProblem(404, 'NOT_FOUND');
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

export interface ComplaintListItem {
  id: string;
  batch: BatchListItem;
  text: string;
  status: string;
  decision: string | null;
  createdAt: string;
  decidedAt: string | null;
}
export interface ComplaintView extends ComplaintListItem {
  contact: string | null;
  decisionComment: string | null;
  inspector: ActorRef | null;
  labTestId: string | null;
  recallId: string | null;
}

type Row = {
  id: string;
  batch_id: string;
  text: string;
  status: string;
  decision: string | null;
  created_at: unknown;
  decided_at: unknown;
  contact: string | null;
  decision_comment: string | null;
  inspector_id: string | null;
  lab_test_id: string | null;
  recall_id: string | null;
};

const complaintAudit = (r: Row) => ({
  status: r.status,
  decision: r.decision,
  decisionComment: r.decision_comment,
  inspectorId: r.inspector_id,
  labTestId: r.lab_test_id,
  recallId: r.recall_id,
  decidedAt: isoOrNull(r.decided_at),
});

/**
 * Body-level rules of ComplaintDecision the discriminated schema cannot word as the contract does: `labOrgId` with a
 * decision other than LAB_TEST and `blockUpstream` with one other than RECALL → `validation.notAllowed`; LAB_TEST
 * without `labOrgId` → `validation.required`; no `decision` → `validation.required`. Reported in the same 400 as the schema's errors (they win per field).
 */
function decisionRules(raw: unknown): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return errors;
  const r = raw as Record<string, unknown>;
  // P19: a missing discriminator is `required` (the discriminated union alone reports `enum`).
  if (r.decision === undefined) errors.decision = ['validation.required'];
  if (typeof r.decision !== 'string') return errors;
  if ('labOrgId' in r && r.decision !== 'LAB_TEST') errors.labOrgId = ['validation.notAllowed'];
  if ('blockUpstream' in r && r.decision !== 'RECALL') errors.blockUpstream = ['validation.notAllowed'];
  if (r.decision === 'LAB_TEST' && !('labOrgId' in r)) errors.labOrgId = ['validation.required'];
  return errors;
}

export function complaintsService(c: Container) {
  const { db } = c;

  async function views(ids: readonly string[]): Promise<ComplaintView[]> {
    if (ids.length === 0) return [];
    const rows = (await db
      .selectFrom('complaints')
      .selectAll()
      .where('id', 'in', [...ids])
      .execute()) as Row[];
    const batches = new Map(
      (
        await loadListItems(
          db,
          rows.map((r) => r.batch_id),
        )
      ).map((b) => [b.id, b]),
    );
    const actors = await actorRefs(
      db,
      c.fileUrls,
      rows.map((r) => r.inspector_id),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      return [
        {
          id: r.id,
          batch: batches.get(r.batch_id)!,
          text: r.text,
          status: r.status,
          decision: r.decision,
          createdAt: iso(r.created_at),
          decidedAt: isoOrNull(r.decided_at),
          contact: r.contact,
          decisionComment: r.decision_comment,
          inspector: r.inspector_id ? (actors.get(r.inspector_id) ?? null) : null,
          labTestId: r.lab_test_id,
          recallId: r.recall_id,
        },
      ];
    });
  }

  async function card(id: string): Promise<ComplaintView> {
    const [v] = await views([id]);
    return v!;
  }

  /** The non-deleted complaint `FOR NO KEY UPDATE` (R52 `complaint`), else 404. */
  async function lockComplaint(tx: Tx, id: string): Promise<Row> {
    const r = await tx
      .selectFrom('complaints')
      .selectAll()
      .where('id', '=', id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!r || r.deleted_at !== null) throw notFound();
    return r as Row;
  }

  return {
    /** listComplaints — non-deleted complaints; filters joined by AND; `x-sort`. */
    async list(query: Request['query']) {
      const q = new QueryReader(query);
      const { page, size, sort } = q.page(SORT);
      const text = q.q();
      const statuses = q.enumList('status', STATUSES);
      const decisions = q.enumList('decision', DECISIONS);
      const batchId = q.uuid('batchId');
      const { from, to } = q.dateRange();
      q.done();
      let base = db
        .selectFrom('complaints as c')
        .innerJoin('batches as b', 'b.id', 'c.batch_id')
        .where('c.deleted_at', 'is', null);
      if (statuses) base = base.where('c.status', 'in', statuses);
      if (decisions) base = base.where('c.decision', 'in', decisions);
      if (batchId) base = base.where('c.batch_id', '=', batchId);
      // from/to — by the UTC date of createdAt.
      if (from) base = base.where('c.created_at', '>=', new Date(`${from}T00:00:00Z`));
      if (to) base = base.where('c.created_at', '<', dayAfter(to));
      if (text !== undefined)
        base = base.where(
          sql<boolean>`(position(lower(${text}) in lower(b.public_code)) > 0
                        OR position(lower(${text}) in lower(c.text)) > 0)`,
        );
      const [{ total }] = (await base.select(sql<string>`count(*)`.as('total')).execute()) as [
        { total: string },
      ];
      const column = sort.field === 'decidedAt' ? sql`c.decided_at` : sql`c.created_at`;
      const rows = await base
        .select('c.id')
        .orderBy(sort.dir === 'asc' ? sql`${column} ASC NULLS LAST` : sql`${column} DESC NULLS LAST`)
        .orderBy(sql`c.id::text COLLATE "C"`)
        .limit(size)
        .offset((page - 1) * size)
        .execute();
      const items = await views(rows.map((r) => r.id));
      return {
        items: items.map(({ id, batch, text: t, status, decision, createdAt, decidedAt }) => ({
          id,
          batch,
          text: t,
          status,
          decision,
          createdAt,
          decidedAt,
        })),
        page,
        size,
        total: Number(total),
      };
    },

    async get(id: string): Promise<ComplaintView> {
      const r = await db
        .selectFrom('complaints')
        .select('id')
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!r) throw notFound();
      return card(id);
    },

    /** startComplaintReview — body (400) → lock → 404 → NEW only → IN_REVIEW, inspector = the user. */
    async review(p: Principal, id: string, body: unknown): Promise<ComplaintView> {
      parseBody(ComplaintReviewRequestSchema, body ?? {});
      await withTx(db, async (tx) => {
        const r = await lockComplaint(tx, id);
        if (!canComplaintGo(r.status, 'IN_REVIEW'))
          throw invalidTransition({ from: r.status, to: 'IN_REVIEW' });
        const after = (await tx
          .updateTable('complaints')
          .set({ status: 'IN_REVIEW', inspector_id: p.userId })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()) as Row;
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'startComplaintReview',
          entityType: 'complaint',
          entityId: id,
          diff: auditDiff(complaintAudit(r), complaintAudit(after)),
        });
      });
      return card(id);
    },

    /**
     * decideComplaint — body (400, with the decision rules) → lock → 404 → DECIDED → (LAB_TEST) the laboratory
     * (400) → DECIDED with the decision's effect. RECALL runs at REPEATABLE READ (the engine).
     */
    async decide(p: Principal, id: string, body: unknown): Promise<ComplaintView> {
      const rules = decisionRules(body);
      let input;
      try {
        input = parseBody(ComplaintDecisionSchema, body);
      } catch (err) {
        if (err instanceof AppProblem && err.extras.errors)
          throw validationProblem({ ...err.extras.errors, ...rules });
        throw err;
      }
      if (Object.keys(rules).length > 0) throw validationProblem(rules);
      const decision = input;
      const out = await withTx(
        db,
        async (tx) => {
          const r = await lockComplaint(tx, id);
          if (!canComplaintGo(r.status, 'DECIDED'))
            throw invalidTransition({ from: r.status, to: 'DECIDED' });
          const b = await tx
            .selectFrom('batches as b')
            .innerJoin('products as pr', 'pr.id', 'b.product_id')
            .select(['b.id', 'b.public_code', 'b.origin_org_id', 'pr.name as product_name'])
            .where('b.id', '=', r.batch_id)
            .executeTakeFirstOrThrow();
          let labTestId: string | null = null;
          let recallId: string | null = null;
          let changed: string[] = [];
          let events: string[] = [];
          if (decision.decision === 'LAB_TEST') {
            const lab = await tx
              .selectFrom('organizations')
              .select(['id', 'name', 'type', 'status'])
              .where('id', '=', decision.labOrgId.toLowerCase())
              .where('deleted_at', 'is', null)
              .executeTakeFirst();
            if (!lab || lab.status !== 'ACTIVE')
              throw validationProblem({ labOrgId: ['validation.notFound'] });
            if (lab.type !== 'LAB') throw validationProblem({ labOrgId: ['validation.labOrg.type'] });
            labTestId = (
              await insertUnplannedLabTest(tx, {
                batch: b,
                lab,
                reason: 'COMPLAINT',
                actorId: p.userId,
                action: 'decideComplaint',
              })
            ).id;
          }
          if (decision.decision === 'RECALL') {
            const outcome = await startRecall(tx, {
              sourceBatchId: b.id,
              trigger: 'COMPLAINT',
              reason: decision.comment,
              blockUpstream: decision.blockUpstream ?? false,
              complaintId: id,
              actorId: p.userId,
              action: 'decideComplaint',
            });
            recallId = outcome.recallId;
            changed = outcome.changedCodes;
            events = outcome.eventIds;
          }
          const after = (await tx
            .updateTable('complaints')
            .set({
              status: 'DECIDED',
              decision: decision.decision,
              decision_comment: decision.comment,
              inspector_id: p.userId,
              decided_at: sql`now()`,
              lab_test_id: labTestId,
              recall_id: recallId,
            })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow()) as Row;
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'decideComplaint',
            entityType: 'complaint',
            entityId: id,
            diff: auditDiff(complaintAudit(r), complaintAudit(after)),
          });
          return { changed, events };
        },
        decision.decision === 'RECALL' ? RECALL_TX : {},
      );
      await dropPublicPages(c.redis, out.changed);
      await c.relay.publish(out.events);
      return card(id);
    },
  };
}
