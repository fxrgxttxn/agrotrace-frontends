import { z } from 'zod';
import { codePointString, uuid } from './common.js';

export const PublicComplaintRequestSchema = z
  .object({
    text: codePointString(10, 2000, /\S/),
    contact: codePointString(1, 255, /\S/).optional(),
    altcha: codePointString(1, 4096),
  })
  .strict();
export type PublicComplaintRequest = z.infer<typeof PublicComplaintRequestSchema>;

/** Body is optional at the operation level; when sent it must be `{}`. */
export const ComplaintReviewRequestSchema = z.object({}).strict();
export type ComplaintReviewRequest = z.infer<typeof ComplaintReviewRequestSchema>;

const comment = codePointString(1, 1000, /\S/);

export const ComplaintDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('REJECT'), comment }).strict(),
  z.object({ decision: z.literal('LAB_TEST'), comment, labOrgId: uuid }).strict(),
  z.object({ decision: z.literal('RECALL'), comment, blockUpstream: z.boolean().default(false) }).strict(),
]);
export type ComplaintDecision = z.infer<typeof ComplaintDecisionSchema>;
