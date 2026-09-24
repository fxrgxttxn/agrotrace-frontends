import { z } from 'zod';
import { atLeastOneKey, email, fileUpload, nameString, uuid } from './common.js';

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'validation.phone.format')
  .nullable();

export const MeUpdateSchema = atLeastOneKey(
  z
    .object({
      fullName: nameString,
      phone,
    })
    .partial()
    .strict(),
);
export type MeUpdate = z.infer<typeof MeUpdateSchema>;

export const ImageUploadSchema = z.object({ file: fileUpload }).strict();
export type ImageUpload = z.infer<typeof ImageUploadSchema>;

export const LogoUploadSchema = z.object({ file: fileUpload }).strict();
export type LogoUpload = z.infer<typeof LogoUploadSchema>;

export const ChannelsUpdateSchema = z
  .object({
    email: z.boolean(),
    telegram: z.boolean(),
  })
  .strict();
export type ChannelsUpdate = z.infer<typeof ChannelsUpdateSchema>;

export const RoleCodeSchema = z.enum(['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN']);

const roles = z
  .array(RoleCodeSchema)
  .min(1, 'validation.required')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'validation.duplicate',
  });

export const UserInviteSchema = z
  .object({
    email,
    fullName: nameString,
    roles,
    isOrgAdmin: z.boolean(),
    organizationId: uuid.optional(),
  })
  .strict();
export type UserInvite = z.infer<typeof UserInviteSchema>;

export const UserPatchSchema = atLeastOneKey(
  z
    .object({
      roles,
      isOrgAdmin: z.boolean(),
      status: z.enum(['ACTIVE', 'BLOCKED']),
    })
    .partial()
    .strict(),
);
export type UserPatch = z.infer<typeof UserPatchSchema>;

export const MarkReadRequestSchema = z.union([
  z
    .object({
      ids: z
        .array(uuid)
        .min(1)
        .max(100)
        .refine((arr) => new Set(arr).size === arr.length, {
          message: 'validation.duplicate',
        }),
    })
    .strict(),
  z
    .object({
      upToSeq: z.number().int().min(1),
    })
    .strict(),
]);
export type MarkReadRequest = z.infer<typeof MarkReadRequestSchema>;
