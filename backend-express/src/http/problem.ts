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
  // A path parameter with a malformed percent-escape (Express: URIError "Failed to decode param", status 400) — the
  // path identifies no resource (I2).
  if (err instanceof URIError) return new AppProblem(404, 'NOT_FOUND');
  const e = err as HttpParserError;
  switch (e?.type) {
    case 'entity.parse.failed':
      // Malformed JSON body: the contract names no field, so the error sits at the body root (as toFieldErrors does).
      return validationProblem({ _root: ['validation.invalid'] });
    case 'entity.too.large':
      return new AppProblem(413, 'FILE_TOO_LARGE', { params: { maxBytes: JSON_BODY_LIMIT_BYTES } });
    // P7: a body that cannot be read as JSON (unsupported charset/encoding, aborted transfer) — body-level error.
    case 'encoding.unsupported':
    case 'charset.unsupported':
    case 'request.aborted':
    case 'request.size.invalid':
    case 'stream.encoding.set':
    case 'stream.not.readable':
      return validationProblem({ _root: ['validation.invalid'] });
    default:
      return fromHttpError(e);
  }
}

/**
 * Any other client error raised by Express or its middleware as an http-error (numeric 4xx `status`, `expose`):
 * mapped by status; the problem never carries the library's message. Anything else (5xx, plain errors) — null.
 */
function fromHttpError(e: HttpParserError | undefined): AppProblem | null {
  const status = e?.status ?? (e as { statusCode?: number } | undefined)?.statusCode;
  if (typeof status !== 'number' || status < 400 || status > 499 || e?.expose === false) return null;
  switch (status) {
    case 404:
      return new AppProblem(404, 'NOT_FOUND');
    case 413:
      return new AppProblem(413, 'FILE_TOO_LARGE', { params: { maxBytes: JSON_BODY_LIMIT_BYTES } });
    case 415:
      return new AppProblem(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: ['application/json'] } });
    default:
      return validationProblem({ _root: ['validation.invalid'] });
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

/**
 * P8: a raw path with an empty segment (`//`, `///`, anywhere — also before `/api/v1`) is no contract path: 404
 * NOT_FOUND. Checked on `req.originalUrl` before the query string, early in the chain, because Express collapses
 * repeated slashes at router mount boundaries (`/api/v1//health/live` would otherwise reach /health/live).
 */
export function rejectEmptySegments(): RequestHandler {
  return (req, res, next) => {
    const raw = req.originalUrl.split('?')[0]!;
    if (raw.includes('//')) {
      sendProblem(res, new AppProblem(404, 'NOT_FOUND'));
      return;
    }
    next();
  };
}

/**
 * 405 before any route (I1): a request whose path is a contract path but whose method the contract does not declare
 * for it — OPTIONS included — is 405 METHOD_NOT_ALLOWED with `Allow` = the declared methods
 * (components.responses.MethodNotAllowed, P3). HEAD counts as GET. OPTIONS on any other path is 404 (Express would
 * otherwise answer it itself with `200 text/html` and its own Allow list).
 */
export function methodGuard(allowedMethods: (path: string) => string[]): RequestHandler {
  return (req, res, next) => {
    const allow = allowedMethods(req.path);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (allow.length > 0 && !allow.includes(method)) {
      sendProblem(res, new AppProblem(405, 'METHOD_NOT_ALLOWED', { headers: { Allow: allow.join(', ') } }));
      return;
    }
    if (allow.length === 0 && method === 'OPTIONS') {
      sendProblem(res, new AppProblem(404, 'NOT_FOUND'));
      return;
    }
    next();
  };
}

/** Terminal handler for requests no route matched (a declared but not yet implemented operation included): 404. */
export function notFoundHandler(): RequestHandler {
  return (_req, res) => {
    sendProblem(res, new AppProblem(404, 'NOT_FOUND'));
  };
}
