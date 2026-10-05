import { z } from 'zod';
import { codePointString, email, errorMap, inn, nameString, password, uuid } from './common.js';

const totpCode = z.string({ errorMap }).regex(/^\d{6}$/, 'validation.totp.format');
const token = codePointString(16, 256);

export const LoginRequestSchema = z
  .object(
    {
      email,
      password: codePointString(1, 128),
    },
    { errorMap },
  )
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const TwoFactorVerifyRequestSchema = z
  .object(
    {
      challengeId: uuid,
      code: totpCode,
    },
    { errorMap },
  )
  .strict();
export type TwoFactorVerifyRequest = z.infer<typeof TwoFactorVerifyRequestSchema>;

export const TwoFactorSetupRequestSchema = z
  .object(
    {
      code: totpCode.optional(),
    },
    { errorMap },
  )
  .strict();
export type TwoFactorSetupRequest = z.infer<typeof TwoFactorSetupRequestSchema>;

export const ForgotPasswordRequestSchema = z
  .object(
    {
      email,
    },
    { errorMap },
  )
  .strict();
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z
  .object(
    {
      token,
      password,
    },
    { errorMap },
  )
  .strict();
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

const RegistrableOrganizationType = z.enum(['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY'], {
  errorMap,
});

export const RegisterOrganizationRequestSchema = z
  .object(
    {
      inn,
      type: RegistrableOrganizationType,
      name: nameString.optional(),
      regionCode: codePointString(1, 8),
      admin: z
        .object(
          {
            email,
            fullName: nameString,
            password,
          },
          { errorMap },
        )
        .strict(),
    },
    { errorMap },
  )
  .strict();
export type RegisterOrganizationRequest = z.infer<typeof RegisterOrganizationRequestSchema>;

export const AcceptInviteRequestSchema = z
  .object(
    {
      token,
      fullName: nameString,
      password,
    },
    { errorMap },
  )
  .strict();
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>;
