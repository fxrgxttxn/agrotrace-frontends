import { canUseAsInput, checkMassBalance, compareDecimalStrings } from '@agrotrace/domain';
import { ProcessingRequestSchema } from '@agrotrace/validation';
import { massWire, parseBody } from '../http/body.js';
import { json, type Handler } from '../http/context.js';
import { ApiError, businessRule, forbidden, validation } from '../http/problem.js';
import { insertBatch, transition, traverse } from '../domain/production.js';
import { visibleBatchIds } from '../domain/visibility.js';
import type { BatchRow } from '../store/types.js';
import { batchView } from '../views/batches.js';

export const processingHandlers: Record<string, Handler> = {
  async processBatches(ctx) {
    const p = ctx.user();
    const input = parseBody(ProcessingRequestSchema, await ctx.json(), (raw, add) =>
      massWire(raw, add, [
        ['inputs', 'massUsedKg'],
        ['outputs', 'massKg'],
      ]),
    );
    const s = ctx.store;
    const visible = visibleBatchIds(s, p);
    const errors: Record<string, string[]> = {};
    const inputs: { row: BatchRow; massUsedKg: string }[] = [];
    input.inputs.forEach((it, i) => {
      const b = s.get('batches', it.batchId.toLowerCase());
      if (!b || !visible.has(b.id)) errors[`inputs[${i}].batchId`] = ['validation.notFound'];
      else {
        if (compareDecimalStrings(it.massUsedKg, b.mass_kg) > 0) errors[`inputs[${i}].massUsedKg`] = ['validation.mass.exceedsBatch'];
        inputs.push({ row: b, massUsedKg: it.massUsedKg });
      }
    });
    input.outputs.forEach((o, i) => {
      const prod = s.get('products', o.productId.toLowerCase());
      if (!prod || prod.deleted_at !== null) errors[`outputs[${i}].productId`] = ['validation.notFound'];
    });
    if (Object.keys(errors).length > 0) throw validation(errors);
    for (const { row } of inputs) {
      if (row.holder_org_id !== p.orgId) throw forbidden({ reason: 'NOT_HOLDER', publicCode: row.public_code }, 'Not the batch holder');
      if (row.status === 'Blocked' || row.status === 'Recalled') throw businessRule('BR-06', { publicCode: row.public_code, status: row.status });
      if (!canUseAsInput({ status: row.status }).allowed) throw businessRule('BR-05', { publicCode: row.public_code, status: row.status });
    }
    const balance = checkMassBalance({
      inputs: inputs.map((i) => ({ massUsedKg: i.massUsedKg, lossNormPercent: s.must('products', i.row.product_id).loss_norm_percent })),
      outputs: input.outputs.map((o) => ({ massKg: o.massKg })),
    });
    if (!('ok' in balance)) throw validation({ inputs: ['validation.minItems'] });
    const { ok, ...totals } = balance;
    if (!ok) throw businessRule('BR-04', totals);
    for (const { row } of inputs) transition(s, row, 'Processed', 'PROCESSED', p.userId);
    const producedAt = s.nowIso();
    const outputs: BatchRow[] = [];
    for (const o of input.outputs) {
      const b = insertBatch(s, {
        product_id: o.productId.toLowerCase(),
        origin_org_id: p.orgId,
        holder_org_id: p.orgId,
        field_id: null,
        kind: 'DERIVED',
        mass_kg: o.massKg,
        harvested_at: null,
        produced_at: producedAt,
        test_required: false,
        test_reason: 'NONE',
        created_by: p.userId,
      });
      transition(s, b, 'Approved', 'TEST_NOT_REQUIRED', null);
      for (const i of inputs) {
        if (traverse(s, i.row.id, 'UP', 1000).has(b.id))
          throw new ApiError(409, 'GRAPH_CYCLE', { title: 'Batch graph cycle', params: { parentCode: i.row.public_code, childCode: b.public_code } });
        s.insert('batch_links', {
          id: s.id('batch_link'),
          parent_batch_id: i.row.id,
          child_batch_id: b.id,
          mass_used_kg: i.massUsedKg,
          created_at: producedAt,
        });
      }
      outputs.push(b);
    }
    return json(201, { outputs: outputs.map((b) => batchView(ctx, p, b)), balance: totals });
  },
};
