import { z } from 'zod';
import { codePointString, errorMap, uuid } from './common.js';

export const PublicComplaintRequestSchema = z
  .object(
    {
      text: codePointString(10, 2000, /\S/),
      contact: codePointString(1, 255, /\S/).optional(),
      altcha: codePointString(1, 4096),
    },
    { errorMap },
  )
  .strict();
export type PublicComplaintRequest = z.infer<typeof PublicComplaintRequestSchema>;

export const ComplaintReviewRequestSchema = z.object({}, { errorMap }).strict();
export type ComplaintReviewRequest = z.infer<typeof ComplaintReviewRequestSchema>;

const comment = codePointString(1, 1000, /\S/);

export const ComplaintDecisionSchema = z.discriminatedUnion(
  'decision',
  [
    z.object({ decision: z.literal('REJECT', { errorMap }), comment }, { errorMap }).strict(),
    z
      .object({ decision: z.literal('LAB_TEST', { errorMap }), comment, labOrgId: uuid }, { errorMap })
      .strict(),
    z
      .object(
        {
          decision: z.literal('RECALL', { errorMap }),
          comment,
          blockUpstream: z.boolean({ errorMap }).default(false),
        },
        { errorMap },
      )
      .strict(),
  ],
  { errorMap },
);
export type ComplaintDecision = z.infer<typeof ComplaintDecisionSchema>;
