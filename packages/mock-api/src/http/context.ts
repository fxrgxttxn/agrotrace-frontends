import type { OperationMeta } from '../contract/types.js';
import type { Mock } from '../runtime.js';
import type { Principal } from '../store/types.js';
import { readJson } from './body.js';
import { ApiError } from './problem.js';
import { QueryReader } from './params.js';

export interface Ctx extends Mock {
  request: Request;
  url: URL;
  op: OperationMeta;
  params: Record<string, string>;
  principal: Principal | null;
  user(): Principal;
  query(): QueryReader;
  json(optional?: boolean): Promise<unknown>;
  form(): Promise<FormData>;
}

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

export function makeCtx(m: Mock, request: Request, url: URL, op: OperationMeta, params: Record<string, string>, principal: Principal | null): Ctx {
  return {
    ...m,
    request,
    url,
    op,
    params,
    principal,
    user() {
      if (!principal) throw new Error(`${op.operationId}: no principal`);
      return principal;
    },
    query: () => new QueryReader(url.searchParams),
    json: (optional) => readJson(request, optional),
    async form() {
      try {
        return await request.formData();
      } catch {
        throw new ApiError(400, 'VALIDATION', { errors: { file: ['validation.required'] } });
      }
    },
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}

export function problemResponse(e: ApiError): Response {
  return new Response(JSON.stringify(e.body()), {
    status: e.status,
    headers: { 'Content-Type': 'application/problem+json', ...(e.extras.headers ?? {}) },
  });
}
