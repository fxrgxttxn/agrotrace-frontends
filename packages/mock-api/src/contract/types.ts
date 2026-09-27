export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH';

/** One operation of the contract with the extensions the mock enforces (see scripts/gen-contract.ts). */
export interface OperationMeta {
  operationId: string;
  method: HttpMethod;
  /** Path template relative to `/api/v1`, e.g. `/batches/{id}`. */
  path: string;
  /** `x-roles`: role codes, `ANY` or `PUBLIC`. */
  roles: string[];
  /** `x-org-admin`: roles other than ADMIN must be the head of their organization. */
  orgAdmin: boolean;
  /** `x-idempotent`: `Idempotency-Key` is required. */
  idempotent: boolean;
  /** `x-rate-limit` scopes (besides `user`, which applies to every Bearer request). */
  rateLimit: string[];
  /** Bearer security applies (false for `security: []` and the SSE stream). */
  bearer: boolean;
  /** `x-access: signed` — a signed URL may replace the Bearer token. */
  signedAccess: boolean;
  sort?: { fields: string[]; default: string };
  reportAccess?: Record<string, { roles: string[]; headRoles: string[] }>;
}
