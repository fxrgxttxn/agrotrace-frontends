import { ApiProblem } from '@agrotrace/api-client';
import { ResetPasswordRequestSchema } from '@agrotrace/validation';

export function tokenLooksValid(token: string | undefined): token is string {
  return token !== undefined && ResetPasswordRequestSchema.shape.token.safeParse(token).success;
}

export function deadToken(e: unknown): boolean {
  return e instanceof ApiProblem && (e.code === 'TOKEN_EXPIRED' || Boolean(e.errors?.token));
}
