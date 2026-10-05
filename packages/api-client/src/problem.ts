import type { components } from './schema';

export type ProblemCode = components['schemas']['ProblemCode'];
export type ProblemBody = components['schemas']['Problem'];

export class ApiProblem extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly code: ProblemCode;
  readonly detail?: string;
  readonly rule?: string;
  readonly params?: Record<string, unknown>;
  readonly errors?: Record<string, string[]>;

  constructor(body: ProblemBody, status: number, options?: { cause?: unknown }) {
    super(body.detail ?? body.title, options?.cause !== undefined ? { cause: options.cause } : undefined);
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

  static transient(title: string, status: number, cause?: unknown): ApiProblem {
    return new ApiProblem(
      { type: '/problems/backend-unavailable', title, status, code: 'BACKEND_UNAVAILABLE' },
      status,
      { cause },
    );
  }
}

interface OpenapiFetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

export function unwrap<T>(result: OpenapiFetchResult<T>): T {
  if (result.error !== undefined) {
    throw new ApiProblem(result.error as ProblemBody, result.response.status);
  }
  return result.data as T;
}
