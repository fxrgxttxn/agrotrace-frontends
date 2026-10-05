export type ProblemCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'VERSION_CONFLICT'
  | 'BUSINESS_RULE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'ACCOUNT_LOCKED'
  | 'INVALID_CREDENTIALS'
  | 'TWO_FACTOR_REQUIRED'
  | 'INVALID_TWO_FACTOR_CODE'
  | 'TOKEN_EXPIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'CAPTCHA_FAILED'
  | 'GRAPH_CYCLE'
  | 'BACKEND_UNAVAILABLE'
  | 'EXTERNAL_UNAVAILABLE'
  | 'INTERNAL'
  | 'NO_LAB_AVAILABLE'
  | 'IDEMPOTENCY_KEY_IN_PROGRESS'
  | 'REFERENCE_IN_USE'
  | 'METHOD_NOT_ALLOWED';

const TITLES: Record<ProblemCode, string> = {
  VALIDATION: 'Validation failed',
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  INVALID_TRANSITION: 'Invalid status transition',
  VERSION_CONFLICT: 'Version conflict',
  BUSINESS_RULE: 'Business rule violated',
  FILE_TOO_LARGE: 'File too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
  RATE_LIMITED: 'Too many requests',
  ACCOUNT_LOCKED: 'Account locked',
  INVALID_CREDENTIALS: 'Invalid credentials',
  TWO_FACTOR_REQUIRED: 'Two-factor authentication required',
  INVALID_TWO_FACTOR_CODE: 'Invalid two-factor code',
  TOKEN_EXPIRED: 'Token expired',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key reused',
  INVALID_IDEMPOTENCY_KEY: 'Invalid idempotency key',
  CAPTCHA_FAILED: 'Captcha failed',
  GRAPH_CYCLE: 'Graph cycle',
  BACKEND_UNAVAILABLE: 'Backend unavailable',
  EXTERNAL_UNAVAILABLE: 'External service unavailable',
  INTERNAL: 'Internal server error',
  NO_LAB_AVAILABLE: 'No laboratory available',
  IDEMPOTENCY_KEY_IN_PROGRESS: 'Idempotency key in progress',
  REFERENCE_IN_USE: 'Reference in use',
  METHOD_NOT_ALLOWED: 'Method not allowed',
};

export interface ProblemExtras {
  title?: string;
  detail?: string;
  rule?: string;
  params?: Record<string, unknown>;
  errors?: Record<string, string[]>;
  headers?: Record<string, string>;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  rule?: string;
  params?: Record<string, unknown>;
  errors?: Record<string, string[]>;
}

export const problemType = (code: ProblemCode): string => `/problems/${code.toLowerCase().replace(/_/g, '-')}`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProblemCode,
    readonly extras: ProblemExtras = {},
  ) {
    super(extras.title ?? TITLES[code]);
    this.name = 'ApiError';
  }

  body(): ProblemBody {
    const { title, detail, rule, params, errors } = this.extras;
    return {
      type: problemType(this.code),
      title: title ?? TITLES[this.code],
      status: this.status,
      code: this.code,
      ...(detail !== undefined && { detail }),
      ...(rule !== undefined && { rule }),
      ...(params !== undefined && { params }),
      ...(errors !== undefined && { errors }),
    };
  }
}

export const validation = (errors: Record<string, string[]>): ApiError => new ApiError(400, 'VALIDATION', { errors });

export const notFound = (title?: string): ApiError => new ApiError(404, 'NOT_FOUND', title ? { title } : {});

export const forbidden = (params?: Record<string, unknown>, title?: string): ApiError =>
  new ApiError(403, 'FORBIDDEN', { ...(params && { params }), ...(title && { title }) });

export const invalidTransition = (params: Record<string, unknown>): ApiError =>
  new ApiError(409, 'INVALID_TRANSITION', { params });

export const versionConflict = (currentVersion: number): ApiError =>
  new ApiError(409, 'VERSION_CONFLICT', { params: { currentVersion } });

export const businessRule = (rule: string, params: Record<string, unknown>): ApiError =>
  new ApiError(422, 'BUSINESS_RULE', { rule, params });

export class ErrorBag {
  readonly errors: Record<string, string[]> = {};
  add(path: string, key: string): void {
    const list = (this.errors[path] ??= []);
    if (!list.includes(key)) list.push(key);
  }
  has(path?: string): boolean {
    return path === undefined ? Object.keys(this.errors).length > 0 : path in this.errors;
  }
  throwIfAny(): void {
    if (this.has()) throw validation(this.errors);
  }
}
