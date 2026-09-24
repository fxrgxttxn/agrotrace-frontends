import { z } from 'zod';
import { codePointString, email, nameString, password, uuid } from './common.js';

const totpCode = z.string().regex(/^\d{6}$/, 'validation.totp.format');
const token = codePointString(16, 256);

export const LoginRequestSchema = z
  .object({
    email,
    password: codePointString(1, 128),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const TwoFactorVerifyRequestSchema = z
  .object({
    challengeId: uuid,
    code: totpCode,
  })
  .strict();
export type TwoFactorVerifyRequest = z.infer<typeof TwoFactorVerifyRequestSchema>;

export const TwoFactorSetupRequestSchema = z
  .object({
    code: totpCode.optional(),
  })
  .strict();
export type TwoFactorSetupRequest = z.infer<typeof TwoFactorSetupRequestSchema>;

export const ForgotPasswordRequestSchema = z
  .object({
    email,
  })
  .strict();
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z
  .object({
    token,
    password,
  })
  .strict();
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

const RegistrableOrganizationType = z.enum(['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY']);

// Wire format only (`^\d{10}(\d{2})?$`, matching the contract exactly): the
// FNS checksum is deliberately NOT enforced here. An INN failing checksum is
// simply one DaData will not find, and the server already reports that as
// 400 `validation.inn.notFound` — duplicating the checksum client-side would
// reject the contract's own (fictional, checksum-invalid) example INN. The
// checksum-validating `inn` primitive (common.ts) remains available for
// callers that want an earlier, purely-client-side check.
const registrationInn = z.string().regex(/^\d{10}(\d{2})?$/, 'validation.inn.format');

export const RegisterOrganizationRequestSchema = z
  .object({
    inn: registrationInn,
    type: RegistrableOrganizationType,
    name: nameString.optional(),
    regionCode: codePointString(1, 8),
    admin: z
      .object({
        email,
        fullName: nameString,
        password,
      })
      .strict(),
  })
  .strict();
export type RegisterOrganizationRequest = z.infer<typeof RegisterOrganizationRequestSchema>;

export const AcceptInviteRequestSchema = z
  .object({
    token,
    fullName: nameString,
    password,
  })
  .strict();
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>;
