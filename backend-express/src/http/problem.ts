/**
 * RFC 7807 problems (contract `Problem`, info.description). Every error path of the app ends here:
 * `application/problem+json`, `type` = `/problems/<kebab-case code>`, `title`, `status`, `code`, and the optional
 * `detail`/`rule`/`params`/`errors`. Unknown errors become 500 INTERNAL without any internals in the body; they are
 * logged with the request id.
 */
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { toFieldErrors } from '@agrotrace/validation';
import type { Logger } from '../logger.js';

/** contracts/openapi/schemas/common.yaml#/ProblemCode (R5, R42, R48, P3). */
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

/** Default `title` per code — for logs only; clients never rely on it (contract). */
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

/** `VERSION_CONFLICT` → `/problems/version-conflict`. */
export const problemType = (code: ProblemCode): string =>
  `/problems/${code.toLowerCase().replace(/_/g, '-')}`;

export interface ProblemExtras {
  title?: string;
  detail?: string;
  rule?: string;
  params?: Record<string, unknown>;
  errors?: Record<string, string[]>;
  /** Extra response headers (e.g. `Allow`, `Retry-After`). */
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

/** A problem thrown anywhere in a request; the error handler renders it as is. */
export class AppProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: ProblemCode,
    readonly extras: ProblemExtras = {},
  ) {
    super(extras.title ?? TITLES[code]);
    this.name = 'AppProblem';
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

/** 400 VALIDATION with field errors (`Problem.errors`: path → i18n keys). */
export const validationProblem = (errors: Record<string, string[]>): AppProblem =>
  new AppProblem(400, 'VALIDATION', { errors });

export function sendProblem(res: Response, problem: AppProblem): void {
  for (const [k, v] of Object.entries(problem.extras.headers ?? {})) res.setHeader(k, v);
  res.status(problem.status).type('application/problem+json').send(JSON.stringify(problem.body()));
}

/** JSON body limit — the gateway's client_max_body_size (12 MiB, R34/R79). */
export const JSON_BODY_LIMIT_BYTES = 12 * 1024 * 1024;

/** body-parser / raw-body errors carry `type` and `status`. */
interface HttpParserError extends Error {
  type?: string;
  status?: number;
  expose?: boolean;
}

/** Maps any thrown value to the problem the client gets; null = unexpected (500). */
export function toProblem(err: unknown): AppProblem | null {
  if (err instanceof AppProblem) return err;
  if (err instanceof ZodError) return validationProblem(toFieldErrors(err));
  const e = err as HttpParserError;
  switch (e?.type) {
    case 'entity.parse.failed':
      // Malformed JSON body: the contract names no field, so the error sits at the body root (as toFieldErrors does).
      return validationProblem({ _root: ['validation.invalid'] });
    case 'entity.too.large':
      return new AppProblem(413, 'FILE_TOO_LARGE', { params: { maxBytes: JSON_BODY_LIMIT_BYTES } });
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppProblem(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: ['application/json'] } });
    case 'request.aborted':
    case 'request.size.invalid':
    case 'stream.encoding.set':
    case 'stream.not.readable':
      return validationProblem({ _root: ['validation.invalid'] });
    default:
      return null;
  }
}

/** The single error handler (last middleware). */
export function problemHandler(logger: Logger): ErrorRequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express recognizes error handlers by arity (4).
  return (err, req, res, _next) => {
    const problem = toProblem(err);
    const ctx = {
      err,
      requestId: res.locals.requestId as string,
      method: req.method,
      path: req.originalUrl.split('?')[0],
    };
    if (!problem) logger.error(ctx, 'unhandled error');
    else if (problem.status >= 500) logger.error(ctx, 'request failed');
    // A failure after the response started (a stream) can only end the connection.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendProblem(res, problem ?? new AppProblem(500, 'INTERNAL'));
  };
}

/** Terminal handler for paths no route matched: 404 NOT_FOUND, or 405 when the path exists with other methods. */
export function notFoundHandler(allowedMethods: (path: string) => string[]): RequestHandler {
  return (req, res) => {
    const allow = allowedMethods(req.path);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    // A declared operation that has no route (yet) is simply not found; a path the contract declares only with other
    // methods is 405 METHOD_NOT_ALLOWED with `Allow` (components.responses.MethodNotAllowed, P3).
    if (allow.length > 0 && !allow.includes(method)) {
      sendProblem(res, new AppProblem(405, 'METHOD_NOT_ALLOWED', { headers: { Allow: allow.join(', ') } }));
      return;
    }
    sendProblem(res, new AppProblem(404, 'NOT_FOUND'));
  };
}
