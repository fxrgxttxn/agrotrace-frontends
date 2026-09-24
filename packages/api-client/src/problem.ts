import type { components } from './schema';

export type ProblemCode = components['schemas']['ProblemCode'];
export type ProblemBody = components['schemas']['Problem'];

/** Thrown by {@link unwrap} for every non-2xx response. Mirrors the RFC 7807
 * `application/problem+json` body the contract defines (contracts/openapi/schemas/common.yaml). */
export class ApiProblem extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly code: ProblemCode;
  readonly detail?: string;
  readonly rule?: string;
  readonly params?: Record<string, unknown>;
  readonly errors?: Record<string, string[]>;

  constructor(body: ProblemBody, status: number) {
    super(body.detail ?? body.title);
    this.name = 'ApiProblem';
    this.status = status;
    this.type = body.type;
    this.title = body.title;
    this.code = body.code;
    this.detail = body.detail;
    this.rule = body.rule;
    this.params = body.params;
    this.errors = body.errors;
  }
}

interface OpenapiFetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Unwraps an openapi-fetch result: returns `data` on success, throws {@link ApiProblem} otherwise. */
export function unwrap<T>(result: OpenapiFetchResult<T>): T {
  if (result.error !== undefined) {
    throw new ApiProblem(result.error as ProblemBody, result.response.status);
  }
  return result.data as T;
}
