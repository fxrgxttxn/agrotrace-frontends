import { z } from 'zod';
import type { Schemas } from '@agrotrace/api-client';
import { compareDecimalStrings } from '@agrotrace/domain';
import { ProcessingRequestSchema } from '@agrotrace/validation';
import { normalizeDecimal } from '../../app/forms.svelte';

export type BatchItem = Schemas['BatchListItem'];
export const STEPS = ['inputs', 'outputs', 'balance'] as const;
export type Step = (typeof STEPS)[number];
/** Contract `Mass` pattern (`PositiveMass`/`Mass`): up to 9 integer digits, exactly 3 decimals. */
export const MASS = /^\d{1,9}\.\d{3}$/;

export interface ProcessingValues extends Record<string, unknown> {
  picked: string[];
  used: Record<string, string>;
  outputs: { productId: string; massKg: string }[];
}

/** A schema over the wizard's own values (keyed by batch id for the inputs, by index for the outputs, as
 * `SchemaForm` needs for its `used.<id>` / `outputs.<n>.*` fields): required inputs/outputs, the shared
 * `ProcessingRequestSchema` (its `inputs[i].*`/`outputs[n].*` issues mapped back to their row), the
 * mass-exceeds-batch domain check the server would also make. `batches` is the wizard's fixed stock list (its ids
 * never change while the form is mounted). */
export function processingSchema(batches: BatchItem[]) {
  const byId = new Map(batches.map((b) => [b.id, b]));
  return z.custom<ProcessingValues>().transform((values, ctx) => {
    const marked = new Set<string>();
    const mark = (path: string, message: string) => {
      if (marked.has(path)) return;
      marked.add(path);
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    const inputs = values.picked.map((id) => ({ batchId: id, massUsedKg: normalizeDecimal(values.used[id] ?? '', 3) }));
    if (inputs.length === 0) mark('picked', 'processing.chooseInputs');
    for (const i of inputs) if ((values.used[i.batchId] ?? '').trim() === '') mark(`used.${i.batchId}`, 'validation.required');
    values.outputs.forEach((o, n) => {
      if (!o.productId) mark(`outputs.${n}.productId`, 'validation.required');
      if (o.massKg.trim() === '') mark(`outputs.${n}.massKg`, 'validation.required');
    });
    const outputs = values.outputs.map((o) => ({ productId: o.productId, massKg: normalizeDecimal(o.massKg, 3) }));
    const body = { inputs, outputs: outputs.map((o) => ({ ...o, productId: o.productId || undefined })) };
    const res = ProcessingRequestSchema.safeParse(body);
    if (!res.success)
      for (const issue of res.error.issues) {
        const [head, index, leaf] = issue.path;
        if (typeof index !== 'number' || typeof leaf !== 'string') continue;
        if (head === 'inputs') {
          const id = inputs[index]?.batchId;
          if (id) mark(`used.${id}`, String(issue.message));
        } else if (head === 'outputs') mark(`outputs.${index}.${leaf}`, String(issue.message));
      }
    for (const i of inputs) {
      const key = `used.${i.batchId}`;
      if (marked.has(key)) continue;
      const b = byId.get(i.batchId);
      if (b && MASS.test(i.massUsedKg) && compareDecimalStrings(i.massUsedKg, b.massKg) > 0)
        mark(key, 'validation.mass.exceedsBatch');
    }
    if (marked.size > 0) return z.NEVER;
    return { inputs, outputs } satisfies Schemas['ProcessingRequest'];
  });
}

/** Static allowlist of server-error paths this form recognises (`used.<id>` per batch, `outputs.<n>.*` up to the
 * contract's limit of 20 rows) — outputs can grow/shrink, but `SchemaForm.fields` is fixed once; unused entries are
 * harmless. */
export function processingFields(batches: BatchItem[]): string[] {
  const outputs = Array.from({ length: 20 }, (_, n) => [`outputs.${n}.productId`, `outputs.${n}.massKg`]).flat();
  return ['picked', ...batches.map((b) => `used.${b.id}`), ...outputs];
}
