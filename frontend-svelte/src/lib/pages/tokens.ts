import { ApiProblem } from '@agrotrace/api-client';
import { ResetPasswordRequestSchema } from '@agrotrace/validation';

/** A one-time token of an email link (16–256 code points); anything else is a dead link without asking the API. */
export function tokenLooksValid(token: string | undefined): token is string {
  return token !== undefined && ResetPasswordRequestSchema.shape.token.safeParse(token).success;
}

/** The answer says the emailed link is dead (used, expired, or a token the server refuses). */
export function deadToken(e: unknown): boolean {
  return e instanceof ApiProblem && (e.code === 'TOKEN_EXPIRED' || Boolean(e.errors?.token));
}
