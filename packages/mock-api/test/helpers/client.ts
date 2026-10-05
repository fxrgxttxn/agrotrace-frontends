import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { inject } from 'vitest';
import { OPERATIONS } from '../../src/contract/operations.generated.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export const BASE = 'http://localhost/api/v1';
const DOC_ID = 'urn:agrotrace:openapi';

let ajv: Ajv2020 | null = null;
const contract = (): Json => inject('contract');

function getAjv(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
    addFormats(ajv);
    ajv.addFormat('binary', true);
    ajv.addSchema(contract(), DOC_ID);
  }
  return ajv;
}

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

function deref(node: Json): Json {
  let cur = node;
  while (cur && typeof cur.$ref === 'string')
    cur = (cur.$ref as string)
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((n: Json, k) => n?.[k], contract());
  return cur;
}

const ROUTES = OPERATIONS.map((op) => ({
  op,
  re: new RegExp(`^${op.path.split('/').map((s) => (/^\{[^}]+\}$/.test(s) ? '[^/]+' : s)).join('/')}$`),
  params: op.path.split('{').length,
}));

export function operationOf(method: string, path: string) {
  return ROUTES.filter((r) => r.op.method === method && r.re.test(path)).sort((a, b) => a.params - b.params)[0]?.op;
}

export const coverage = new Map<string, Set<number>>();

export interface Res {
  status: number;
  headers: Headers;
  body: Json;
  bytes: Uint8Array;
  text: string;
}

export interface CallOptions {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  form?: FormData;
  headers?: Record<string, string>;
  noValidate?: boolean;
}

export function contractErrors(operationId: string, method: string, path: string, status: number, mediaType: string | null, body: unknown): string[] {
  const doc = contract();
  const op = doc.paths[path][method.toLowerCase()];
  const raw = op.responses?.[String(status)];
  if (!raw) return [`${operationId}: status ${status} is not declared`];
  const res = deref(raw);
  if (!res.content) return mediaType && status !== 304 && status !== 204 ? [`${operationId} ${status}: no content declared, got ${mediaType}`] : [];
  if (!mediaType || !res.content[mediaType]) return [`${operationId} ${status}: media type ${mediaType} not declared (${Object.keys(res.content).join(', ')})`];
  if (!mediaType.includes('json')) return [];
  if (mediaType === 'application/problem+json') {
    const b = body as { status?: number; code?: string };
    if (b?.status !== status) return [`${operationId} ${status}: problem.status ${b?.status} differs from the HTTP status`];
    const declared = declaredCodes(op, res, status);
    if (!declared.has(b.code!)) return [`${operationId} ${status}: code ${b.code} is not declared for this status (${[...declared].join(', ')})`];
  }
  const base = typeof raw.$ref === 'string' ? (raw.$ref as string).slice(1) : `/paths/${esc(path)}/${method.toLowerCase()}/responses/${status}`;
  const a = getAjv();
  const validate = a.compile({ $ref: `${DOC_ID}#${base}/content/${esc(mediaType)}/schema` });
  return validate(body) ? [] : [`${operationId} ${status}: ${a.errorsText(validate.errors)} — ${JSON.stringify(body).slice(0, 400)}`];
}

export async function call(method: string, path: string, o: CallOptions = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.rawBody !== undefined) {
    body = o.rawBody;
    headers['Content-Type'] ??= 'application/json';
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${BASE}${path}`, { method, headers, body });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const type = response.headers.get('Content-Type')?.split(';')[0]?.trim() ?? null;
  let parsed: Json = null;
  if (type?.includes('json')) parsed = JSON.parse(text);
  const pathOnly = path.split('?')[0]!;
  const op = operationOf(method, pathOnly);
  if (!o.noValidate) {
    if (!op) throw new Error(`no contract operation for ${method} ${pathOnly}`);
    const errors = contractErrors(op.operationId, method, op.path, response.status, bytes.length || response.status === 200 ? type : null, parsed);
    if (errors.length) throw new Error(errors.join('\n'));
    (coverage.get(op.operationId) ?? coverage.set(op.operationId, new Set()).get(op.operationId)!).add(response.status);
  }
  return { status: response.status, headers: response.headers, body: parsed, bytes, text };
}

export async function expectStatus(expected: number, method: string, path: string, o: CallOptions = {}): Promise<Res> {
  const r = await call(method, path, o);
  if (r.status !== expected) throw new Error(`${method} ${path}: expected ${expected}, got ${r.status} ${r.text.slice(0, 500)}`);
  return r;
}

const GENERIC: Record<number, string[]> = {
  400: ['VALIDATION'],
  401: ['UNAUTHORIZED'],
  403: ['FORBIDDEN'],
  404: ['NOT_FOUND'],
  405: ['METHOD_NOT_ALLOWED'],
  409: ['VERSION_CONFLICT', 'INVALID_TRANSITION'],
  413: ['FILE_TOO_LARGE'],
  415: ['UNSUPPORTED_MEDIA_TYPE'],
  422: ['BUSINESS_RULE'],
  429: ['RATE_LIMITED'],
  503: ['EXTERNAL_UNAVAILABLE', 'BACKEND_UNAVAILABLE'],
};

function declaredCodes(op: Json, res: Json, status: number): Set<string> {
  const codes = (deref(contract().components.schemas.ProblemCode).enum ?? []) as string[];
  const text = JSON.stringify([res, op.description ?? '', (op.parameters ?? []).map((p: Json) => deref(p))]);
  const out = new Set(GENERIC[status] ?? []);
  const resText = JSON.stringify(res);
  for (const c of codes) {
    if (resText.includes(c)) out.add(c);
    else if (
      new RegExp(`${status}\\s+(VALIDATION\\s+)?\`?${c}\\b`).test(text) ||
      ((c.startsWith('IDEMPOTENCY') || c === 'INVALID_IDEMPOTENCY_KEY') && text.includes(c))
    )
      out.add(c);
  }
  return out;
}
