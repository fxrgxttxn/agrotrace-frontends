/**
 * Processing (contracts/openapi/paths/processing.yaml; FR-PROD-06, БП-4, BR-04/05/06, D19, D20): inputs of the
 * processor's organization become Processed, each output a new DERIVED batch (Approved, version 2), every
 * (input, output) pair a `batch_links` edge with the input's whole `massUsedKg`.
 *
 * One READ COMMITTED transaction (R47): the existing inputs are locked `FOR NO KEY UPDATE ORDER BY id` right after the body
 * check; references, the per-input rules and the balance run over the locked rows, so a parallel sendWaybill or
 * processing of an input waits and then sees the other's result (InTransit/Processed → BR-05, or its own 409).
 */
import { sql, type Transaction } from 'kysely';
import { canUseAsInput, checkMassBalance, compareCodePoints, compareDecimalStrings } from '@agrotrace/domain';
import { ProcessingRequestSchema } from '@agrotrace/validation';
import type { Container } from '../../container.js';
import { lockBatches } from '../../db/locks.js';
import { withTx } from '../../db/tx.js';
import type { DB } from '../../db/types.generated.js';
import { parseBody } from '../../http/body.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import { transitionBatch } from '../batches/lifecycle.js';
import { batchAudit, notHolder } from '../batches/service.js';
import { loadCard, type BatchCard } from '../batches/view.js';
import { batchVisibleTo } from '../batches/visibility.js';
import { dropPublicPages } from '../public/cache.js';

const businessRule = (rule: string, params: Record<string, unknown>) =>
  new AppProblem(422, 'BUSINESS_RULE', { rule, params });

export interface ProcessingResult {
  outputs: BatchCard[];
  balance: { inputKg: string; allowedKg: string; outputKg: string };
}

/** Ancestors of `batchId` (all depths; UNION terminates on the acyclic graph and on a corrupt cyclic one). */
async function ancestors(tx: Transaction<DB>, batchId: string): Promise<Set<string>> {
  const r = await sql<{ id: string }>`
    WITH RECURSIVE up(id) AS (
      SELECT parent_batch_id FROM batch_links WHERE child_batch_id = ${batchId}
      UNION
      SELECT l.parent_batch_id FROM batch_links l JOIN up ON l.child_batch_id = up.id
    )
    SELECT id FROM up`.execute(tx);
  return new Set(r.rows.map((x) => x.id));
}

export function processingService(c: Container) {
  const { db } = c;

  return {
    async process(p: Principal, body: unknown): Promise<ProcessingResult> {
      const input = parseBody(ProcessingRequestSchema, body, [
        ['inputs', 'massUsedKg'],
        ['outputs', 'massKg'],
      ]);
      const ids = input.inputs.map((i) => i.batchId.toLowerCase());
      const productIds = input.outputs.map((o) => o.productId.toLowerCase());
      const { outputIds, codes, balance } = await withTx(db, async (tx) => {
        const locked = await lockBatches(tx, ids);
        const byId = new Map(locked.map((b) => [b.id, b]));

        // 2. References — every error of the step in one 400.
        const visible = new Set(
          locked.length === 0
            ? []
            : (
                await tx
                  .selectFrom('batches as b')
                  .select('b.id')
                  .where(
                    'b.id',
                    'in',
                    locked.map((b) => b.id),
                  )
                  .where('b.deleted_at', 'is', null)
                  .where(batchVisibleTo(p, sql.ref('b.id')))
                  .execute()
              ).map((r) => r.id),
        );
        const products = new Map(
          (
            await tx
              .selectFrom('products')
              .select(['id', 'name'])
              .where('id', 'in', [...new Set(productIds)])
              .where('deleted_at', 'is', null)
              .forShare()
              .execute()
          ).map((x) => [x.id, x]),
        );
        const errors: Record<string, string[]> = {};
        input.inputs.forEach((it, i) => {
          const b = byId.get(ids[i]!);
          if (!b || !visible.has(b.id)) errors[`inputs[${i}].batchId`] = ['validation.notFound'];
          else if (compareDecimalStrings(it.massUsedKg, b.mass_kg) > 0)
            errors[`inputs[${i}].massUsedKg`] = ['validation.mass.exceedsBatch'];
        });
        productIds.forEach((pid, i) => {
          if (!products.has(pid)) errors[`outputs[${i}].productId`] = ['validation.notFound'];
        });
        if (Object.keys(errors).length > 0) throw validationProblem(errors);

        // 3. Per input in request order: side, BR-06, BR-05.
        const inputs = ids.map((id) => byId.get(id)!);
        for (const b of inputs) {
          if (b.holder_org_id !== p.orgId) throw notHolder(b.public_code);
          if (b.status === 'Blocked' || b.status === 'Recalled')
            throw businessRule('BR-06', { publicCode: b.public_code, status: b.status });
          if (!canUseAsInput({ status: b.status as never }).allowed)
            throw businessRule('BR-05', { publicCode: b.public_code, status: b.status });
        }

        // 4. BR-04 with the loss norm of each input's product.
        const losses = new Map(
          (
            await tx
              .selectFrom('products')
              .select(['id', 'loss_norm_percent'])
              .where('id', 'in', [...new Set(inputs.map((b) => b.product_id))])
              .execute()
          ).map((x) => [x.id, x.loss_norm_percent]),
        );
        const mb = checkMassBalance({
          inputs: input.inputs.map((it, i) => ({
            massUsedKg: it.massUsedKg,
            lossNormPercent: losses.get(inputs[i]!.product_id)!,
          })),
          outputs: input.outputs.map((o) => ({ massKg: o.massKg })),
        });
        if ('error' in mb) throw new Error(`checkMassBalance: ${mb.error}`); // unreachable: minItems 1
        const totals = { inputKg: mb.inputKg, allowedKg: mb.allowedKg, outputKg: mb.outputKg };
        if (!mb.ok) throw businessRule('BR-04', totals);

        // Result.
        const { now } = (await sql<{ now: Date }>`SELECT now() AS now`.execute(tx)).rows[0]!;
        for (const b of [...inputs].sort((x, y) => compareCodePoints(x.id, y.id))) {
          const v = await transitionBatch(tx, b, 'Processed', 'PROCESSED', p.userId);
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'processBatches',
            entityType: 'batch',
            entityId: b.id,
            diff: { status: [b.status, 'Processed'], version: [b.version, v] },
          });
        }
        const outputIds: string[] = [];
        for (const [i, o] of input.outputs.entries()) {
          const b = await tx
            .insertInto('batches')
            .values({
              public_code: sql<string>`next_batch_code()`,
              product_id: productIds[i]!,
              origin_org_id: p.orgId,
              holder_org_id: p.orgId,
              field_id: null,
              kind: 'DERIVED',
              mass_kg: o.massKg,
              harvested_at: null,
              produced_at: now,
              status: 'Created',
              test_required: false,
              test_reason: 'NONE',
              version: 1,
              created_by: p.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await tx
            .insertInto('batch_status_history')
            .values({
              batch_id: b.id,
              from_status: null,
              to_status: 'Created',
              changed_by: p.userId,
              reason: 'CREATED',
              changed_at: sql`now()`,
            })
            .execute();
          const version = await transitionBatch(tx, b, 'Approved', 'TEST_NOT_REQUIRED', null);
          // 5. Defensive acyclicity (п. 7.5): walking up from each parent must never meet the new child.
          for (const parent of inputs) {
            if ((await ancestors(tx, parent.id)).has(b.id) || parent.id === b.id)
              throw new AppProblem(409, 'GRAPH_CYCLE', {
                params: { parentCode: parent.public_code, childCode: b.public_code },
              });
          }
          await tx
            .insertInto('batch_links')
            .values(
              inputs.map((parent, j) => ({
                parent_batch_id: parent.id,
                child_batch_id: b.id,
                mass_used_kg: input.inputs[j]!.massUsedKg,
              })),
            )
            .execute();
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'processBatches',
            entityType: 'batch',
            entityId: b.id,
            diff: auditDiff(null, {
              ...batchAudit({ ...b, status: 'Approved', version }),
              parents: inputs.map((parent, j) => ({
                batchId: parent.id,
                massUsedKg: input.inputs[j]!.massUsedKg,
              })),
            }),
          });
          outputIds.push(b.id);
        }
        return { outputIds, codes: inputs.map((b) => b.public_code), balance: totals };
      });
      await dropPublicPages(c.redis, codes);
      const outputs: BatchCard[] = [];
      for (const id of outputIds) outputs.push(await loadCard(db, p, id));
      return { outputs, balance };
    },
  };
}
