import { http, HttpResponse, type HttpHandler } from 'msw';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export const API_BASE = 'http://localhost/api/v1';
const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
type Method = (typeof METHODS)[number];

export interface ContractOperation {
  operationId: string;
  method: Method;
  path: string;
  op: Json;
}

let doc: Json | null = null;
let ops: Map<string, ContractOperation> | null = null;

export function loadContract(bundled: Json): void {
  doc = bundled;
  ajv = null;
  ops = new Map();
  for (const [path, item] of Object.entries<Json>(bundled.paths))
    for (const method of METHODS)
      if (item[method])
        ops.set(item[method].operationId, {
          operationId: item[method].operationId,
          method,
          path,
          op: item[method],
        });
}

function contractDoc(): Json {
  if (!doc) throw new Error('contract not loaded (test/setup.ts)');
  return doc;
}

const DOC_ID = 'urn:agrotrace:openapi';
let ajv: Ajv2020 | null = null;

function contractAjv(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
    addFormats(ajv);
    ajv.addFormat('binary', true);
    ajv.addSchema(contractDoc(), DOC_ID);
  }
  return ajv;
}

export function responseSchemaErrors(
  operationId: string,
  status: number,
  mediaType: string,
  body: unknown,
): string[] {
  const op = operation(operationId);
  const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
  const raw = op.op.responses?.[String(status)] as Json | undefined;
  if (!raw) return [`status ${status} is not declared`];
  const base =
    typeof raw.$ref === 'string'
      ? (raw.$ref as string).slice(1)
      : `/paths/${esc(op.path)}/${op.method}/responses/${status}`;
  const a = contractAjv();
  const validate = a.compile({ $ref: `${DOC_ID}#${base}/content/${esc(mediaType)}/schema` });
  return validate(body) ? [] : [a.errorsText(validate.errors)];
}

export function operations(): ContractOperation[] {
  if (!ops) throw new Error('contract not loaded (test/setup.ts)');
  return [...ops.values()];
}

export function operation(operationId: string): ContractOperation {
  const found = ops?.get(operationId);
  if (!found) throw new Error(`unknown operationId: ${operationId}`);
  return found;
}

export function deref(node: Json | undefined): Json | undefined {
  let cur = node;
  const seen = new Set<string>();
  while (cur && typeof cur.$ref === 'string') {
    const ref: string = cur.$ref;
    if (seen.has(ref)) throw new Error(`cyclic $ref ${ref}`);
    seen.add(ref);
    cur = ref
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((n: Json, k) => n?.[k], contractDoc());
  }
  return cur;
}

const FORMAT_SAMPLES: Record<string, unknown> = {
  uuid: '00000000-0000-4000-8000-000000000001',
  'date-time': '2026-09-24T09:00:00Z',
  date: '2026-09-24',
  email: 'user@agrotrace.test',
  uri: 'http://localhost/',
};

export function sampleFromSchema(schemaIn: Json | undefined, depth = 0): unknown {
  const schema = deref(schemaIn);
  if (!schema || depth > 12) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.allOf) {
    const merged: Json = {};
    for (const part of schema.allOf) Object.assign(merged, sampleFromSchema(part, depth + 1));
    return merged;
  }
  if (schema.oneOf) return sampleFromSchema(schema.oneOf[0], depth + 1);
  if (schema.anyOf) return sampleFromSchema(schema.anyOf[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== 'null') : schema.type;
  switch (type) {
    case 'object':
    case undefined: {
      if (!schema.properties) return type === 'object' ? {} : null;
      const out: Json = {};
      for (const [k, v] of Object.entries<Json>(schema.properties)) out[k] = sampleFromSchema(v, depth + 1);
      return out;
    }
    case 'array': {
      const n = Math.max(1, schema.minItems ?? 1);
      return Array.from({ length: n }, () => sampleFromSchema(schema.items, depth + 1));
    }
    case 'string':
      if (schema.format && schema.format in FORMAT_SAMPLES) return FORMAT_SAMPLES[schema.format];
      return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    case 'integer':
    case 'number':
      return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 0);
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}

export interface ResponseSpec {
  status: number;
  mediaType: string | null;
  body: unknown;
  headers: Record<string, string>;
}

function responseOf(op: ContractOperation, status: number): Json {
  const res = deref(op.op.responses?.[String(status)]);
  if (!res) throw new Error(`${op.operationId}: status ${status} is not declared in the contract`);
  return res;
}

export function contractExample(operationId: string, status?: number, example?: string): ResponseSpec {
  const op = operation(operationId);
  const code =
    status ??
    Number(
      Object.keys(op.op.responses ?? {})
        .filter((s) => /^2\d\d$/.test(s))
        .sort()[0],
    );
  if (!code) throw new Error(`${operationId}: no 2xx response in the contract`);
  const res = responseOf(op, code);
  const [mediaType, media] = Object.entries<Json>(res.content ?? {})[0] ?? [null, null];
  let body: unknown = null;
  if (media) {
    const named = media.examples ? Object.entries<Json>(media.examples) : [];
    if (example) {
      const hit = named.find(([name]) => name === example);
      if (!hit) throw new Error(`${operationId} ${code}: no example named ${example}`);
      body = deref(hit[1])?.value;
    } else if (named.length) body = deref(named[0]![1])?.value;
    else if (media.example !== undefined) body = media.example;
    else body = sampleFromSchema(media.schema);
  } else if (example) throw new Error(`${operationId} ${code}: no content, no example ${example}`);
  const headers: Record<string, string> = {};
  if (code === 429 || code === 503) headers['Retry-After'] = '1';
  return { status: code, mediaType, body, headers };
}

function toMswPath(path: string): string {
  return API_BASE + path.replace(/\{(\w+)\}/g, ':$1');
}

function reply(spec: ResponseSpec): Response {
  if (spec.status === 204 || spec.mediaType === null)
    return new HttpResponse(null, { status: spec.status, headers: spec.headers });
  if (/json/.test(spec.mediaType))
    return HttpResponse.json(spec.body as never, {
      status: spec.status,
      headers: { ...spec.headers, 'Content-Type': spec.mediaType },
    });
  return new HttpResponse(typeof spec.body === 'string' ? spec.body : '', {
    status: spec.status,
    headers: { ...spec.headers, 'Content-Type': spec.mediaType },
  });
}

function specificity(path: string): number[] {
  return path.split('/').map((seg) => (seg.startsWith('{') ? 1 : 0));
}

function compareSpecificity(a: string, b: string): number {
  const sa = specificity(a);
  const sb = specificity(b);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const d = (sa[i] ?? -1) - (sb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

export function contractHandlers(): HttpHandler[] {
  return operations()
    .filter((o) => o.operationId !== 'streamEvents')
    .sort((a, b) => compareSpecificity(a.path, b.path))
    .map((o) => http[o.method](toMswPath(o.path), () => reply(contractExample(o.operationId))));
}

export interface Override {
  status?: number;
  example?: string;
  body?: unknown;
  headers?: Record<string, string>;
  onRequest?: (
    request: Request,
    params: Record<string, string | readonly string[] | undefined>,
  ) => void | Promise<void>;
  once?: boolean;
}

export function contractResponse(operationId: string, o: Override = {}): HttpHandler {
  const op = operation(operationId);
  const spec = contractExample(operationId, o.status, o.example);
  if (o.body !== undefined) {
    if (spec.mediaType && /json/.test(spec.mediaType)) {
      const errors = responseSchemaErrors(operationId, spec.status, spec.mediaType, o.body);
      if (errors.length)
        throw new Error(
          `${operationId} ${spec.status}: body does not match the contract: ${errors.join('; ')}`,
        );
    }
    spec.body = o.body;
  }
  Object.assign(spec.headers, o.headers ?? {});
  return http[op.method](
    toMswPath(op.path),
    async ({ request, params }) => {
      await o.onRequest?.(request, params);
      return reply(spec);
    },
    { once: o.once ?? false },
  );
}
