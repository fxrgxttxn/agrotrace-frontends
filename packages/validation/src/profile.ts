import { z } from 'zod';
import { atLeastOneKey, email, errorMap, fileUpload, nameString, uuid } from './common.js';

const phone = z
  .string({ errorMap })
  .regex(/^\+[1-9]\d{6,14}$/, 'validation.phone.format')
  .nullable();

export const MeUpdateSchema = atLeastOneKey(
  z
    .object(
      {
        fullName: nameString,
        phone,
      },
      { errorMap },
    )
    .partial()
    .strict(),
);
export type MeUpdate = z.infer<typeof MeUpdateSchema>;

export const ImageUploadSchema = z.object({ file: fileUpload }, { errorMap }).strict();
export type ImageUpload = z.infer<typeof ImageUploadSchema>;

export const LogoUploadSchema = z.object({ file: fileUpload }, { errorMap }).strict();
export type LogoUpload = z.infer<typeof LogoUploadSchema>;

export const ChannelsUpdateSchema = z
  .object(
    {
      email: z.boolean({ errorMap }),
      telegram: z.boolean({ errorMap }),
    },
    { errorMap },
  )
  .strict();
export type ChannelsUpdate = z.infer<typeof ChannelsUpdateSchema>;

export const RoleCodeSchema = z.enum(['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'], {
  errorMap,
});

const roles = z
  .array(RoleCodeSchema, { errorMap })
  .min(1, 'validation.minItems')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'validation.duplicate',
  });

export const UserInviteSchema = z
  .object(
    {
      email,
      fullName: nameString,
      roles,
      isOrgAdmin: z.boolean({ errorMap }),
      organizationId: uuid.optional(),
    },
    { errorMap },
  )
  .strict();
export type UserInvite = z.infer<typeof UserInviteSchema>;

export const UserPatchSchema = atLeastOneKey(
  z
    .object(
      {
        roles,
        isOrgAdmin: z.boolean({ errorMap }),
        status: z.enum(['ACTIVE', 'BLOCKED'], { errorMap }),
      },
      { errorMap },
    )
    .partial()
    .strict(),
);
export type UserPatch = z.infer<typeof UserPatchSchema>;

export const MarkReadRequestSchema = z.union(
  [
    z
      .object(
        {
          ids: z
            .array(uuid, { errorMap })
            .min(1)
            .max(100)
            .refine((arr) => new Set(arr).size === arr.length, {
              message: 'validation.duplicate',
            }),
        },
        { errorMap },
      )
      .strict(),
    z
      .object(
        {
          upToSeq: z.number({ errorMap }).int().min(1),
        },
        { errorMap },
      )
      .strict(),
  ],
  { errorMap },
);
export type MarkReadRequest = z.infer<typeof MarkReadRequestSchema>;
