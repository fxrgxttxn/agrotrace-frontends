import { z } from 'zod';
import { errorMap, isoDateTime, massKg, uuid } from './common.js';

export const BatchCreateSchema = z
  .object(
    {
      fieldId: uuid,
      productId: uuid,
      massKg,
      harvestedAt: isoDateTime,
    },
    { errorMap },
  )
  .strict();
export type BatchCreate = z.infer<typeof BatchCreateSchema>;

/** Body is optional at the operation level; when sent it must be `{}`. */
export const QrRequestSchema = z.object({}, { errorMap }).strict();
export type QrRequest = z.infer<typeof QrRequestSchema>;
