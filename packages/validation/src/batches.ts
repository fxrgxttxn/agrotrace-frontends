import { z } from 'zod';
import { isoDateTime, massKg, uuid } from './common.js';

export const BatchCreateSchema = z
  .object({
    fieldId: uuid,
    productId: uuid,
    massKg,
    harvestedAt: isoDateTime,
  })
  .strict();
export type BatchCreate = z.infer<typeof BatchCreateSchema>;

/** Body is optional at the operation level; when sent it must be `{}`. */
export const QrRequestSchema = z.object({}).strict();
export type QrRequest = z.infer<typeof QrRequestSchema>;
