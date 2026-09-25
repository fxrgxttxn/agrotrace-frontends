/**
 * Response validation against the contract (Global Constraints): the bundled contracts/openapi.yaml, Ajv 2020 in
 * strict mode with formats. `expectContract(res, operationId)` checks that the status is declared for the operation,
 * the media type is a declared one, the body matches its schema (additionalProperties:false included) and the
 * declared headers match theirs; on top, every response carries `X-Backend` = API_BACKEND and a valid `X-Request-Id`
 * (spec 8.3). `expectProblem` does the same for responses outside any operation (unknown path, 405, 413).
 */
import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ApiResponse } from './client.js';
import { API_BACKEND } from './env.js';
import { recordChecked } from './registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped OpenAPI JSON
type Json = Record<string, any>;

const ROOT = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../../contracts/redocly.yaml', import.meta.url));
const DOC_ID = 'urn:agrotrace:openapi';
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
export const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export interface Operation {
  operationId: string;
  method: string;
  path: string;
  pointer: string[];
  op: Json;
}

interface Contract {
  doc: Json;
  ajv: Ajv2020;
  ops: Map<string, Operation>;
  compiled: Map<string, ValidateFunction>;
}

let loading: Promise<Contract> | null = null;

/** The bundled contract (the same document the backends serve at /docs/openapi.json). */
export function contract(): Promise<Contract> {
  loading ??= (async () => {
    const config = await loadConfig({ configPath: CONFIG });
    const doc = (await bundle({ ref: ROOT, config })).bundle.parsed as Json;
    const ajv = new Ajv2020({
      strict: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allErrors: true,
      validateFormats: true,
    });
    addFormats(ajv);
    ajv.addFormat('binary', true);
    ajv.addVocabulary(['example', 'discriminator', 'xml', 'externalDocs']);
    ajv.addVocabulary(['openapi', 'info', 'servers', 'security', 'tags', 'paths', 'components']);
    ajv.addSchema(doc, DOC_ID);
    const ops = new Map<string, Operation>();
    for (const [path, item] of Object.entries<Json>(doc.paths))
      for (const method of METHODS)
        if (item[method])
          ops.set(item[method].operationId, {
            operationId: item[method].operationId,
            method: method.toUpperCase(),
            path,
            pointer: ['paths', path, method],
            op: item[method],
          });
    return { doc, ajv, ops, compiled: new Map() };
  })();
  return loading;
}

const escape = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

function resolve(doc: Json, node: Json): { node: Json; pointer: string[] | null } {
  if (node && typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const pointer = node.$ref
      .slice(2)
      .split('/')
      .map((s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    return { node: pointer.reduce((n: Json, k: string) => n[k], doc), pointer };
  }
  return { node, pointer: null };
}

function validator(c: Contract, pointer: string[]): ValidateFunction {
  const key = pointer.map(escape).join('/');
  let v = c.compiled.get(key);
  if (!v) {
    v = c.ajv.compile({ $ref: `${DOC_ID}#/${key}` });
    c.compiled.set(key, v);
  }
  return v;
}

const isJsonMedia = (mt: string) => /^application\/(.+\+)?json$/.test(mt);

function mediaMatches(declared: string, actual: string): boolean {
  if (declared === actual || declared === '*/*') return true;
  const [t, s] = declared.split('/');
  return s === '*' && actual.startsWith(`${t}/`);
}

export class ContractViolation extends Error {
  constructor(
    res: Pick<ApiResponse, 'method' | 'path' | 'status' | 'text'>,
    where: string,
    problems: string[],
  ) {
    super(
      `${res.method} ${res.path} → ${res.status} violates ${where}:\n  - ${problems.join('\n  - ')}\n  body: ${res.text.slice(0, 2000)}`,
    );
    this.name = 'ContractViolation';
  }
}

/** Headers every response has (spec 8.3): X-Backend of the backend under test, X-Request-Id. */
function commonHeaderProblems(res: ApiResponse): string[] {
  const out: string[] = [];
  const backend = res.headers.get('x-backend');
  if (backend !== API_BACKEND) out.push(`X-Backend is ${JSON.stringify(backend)}, expected "${API_BACKEND}"`);
  const rid = res.headers.get('x-request-id');
  if (rid === null || !REQUEST_ID.test(rid)) out.push(`X-Request-Id is ${JSON.stringify(rid)}`);
  return out;
}

function schemaProblems(c: Contract, pointer: string[], value: unknown, label: string): string[] {
  const v = validator(c, pointer);
  if (v(value)) return [];
  return (v.errors ?? []).map(
    (e) => `${label}${e.instancePath || '/'} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`,
  );
}

/**
 * Throws ContractViolation unless `res` is a response `operationId` may return. Returns the matched response
 * object of the contract.
 */
export async function expectContract(res: ApiResponse, operationId: string): Promise<Json> {
  const c = await contract();
  const op = c.ops.get(operationId);
  if (!op) throw new Error(`unknown operationId ${operationId}`);
  const where = `${operationId} (${op.method} ${op.path})`;
  const responses = op.op.responses as Json;
  const code =
    [String(res.status), `${String(res.status)[0]}XX`, 'default'].find((k) => k in responses) ?? null;
  if (code === null)
    throw new ContractViolation(res, where, [
      `status ${res.status} is not declared (declared: ${Object.keys(responses).join(', ')})`,
    ]);

  const { node: response, pointer: refPtr } = resolve(c.doc, responses[code]);
  const base = refPtr ?? [...op.pointer, 'responses', code];
  const problems = responseProblems(c, res, response, base);
  if (problems.length) throw new ContractViolation(res, where, problems);
  recordChecked({ operationId, status: res.status });
  return response;
}

/** Body, media type and declared headers of `response` (at JSON pointer `base`), plus the common headers. */
function responseProblems(c: Contract, res: ApiResponse, response: Json, base: string[]): string[] {
  const problems = commonHeaderProblems(res);
  // Body and media type.
  const content = (response.content ?? {}) as Json;
  const declared = Object.keys(content);
  if (declared.length === 0) {
    if (res.bytes.length > 0)
      problems.push(`a body was sent, the response declares none (${res.bytes.length} bytes)`);
  } else {
    const mt = declared.find((d) => mediaMatches(d, res.contentType));
    if (!mt) problems.push(`Content-Type "${res.contentType}" is not declared (${declared.join(', ')})`);
    else if (isJsonMedia(res.contentType) && content[mt].schema) {
      if (typeof res.body === 'string' || res.body === null) problems.push('body is not JSON');
      else problems.push(...schemaProblems(c, [...base, 'content', mt, 'schema'], res.body, 'body'));
    }
  }

  // Every problem is self-consistent (RFC 7807 + contract `Problem`): body.status is the HTTP status and type is
  // `/problems/<kebab(code)>`.
  if (res.contentType === 'application/problem+json' && res.body && typeof res.body === 'object') {
    if (res.body.status !== res.status)
      problems.push(`body.status ${res.body.status} != HTTP status ${res.status}`);
    if (typeof res.body.code === 'string' && res.body.type !== problemType(res.body.code))
      problems.push(`body.type ${res.body.type} != ${problemType(res.body.code)} (from code)`);
  }

  // Declared headers.
  for (const [name, h] of Object.entries<Json>(response.headers ?? {})) {
    const { node: header, pointer: hPtr } = resolve(c.doc, h);
    const value = res.headers.get(name);
    if (value === null) {
      if (header.required) problems.push(`required header ${name} is missing`);
      continue;
    }
    if (!header.schema) continue;
    const schema = resolve(c.doc, header.schema).node;
    const t = schema.type;
    const typed =
      t === 'integer' || t === 'number' ? Number(value) : t === 'boolean' ? value === 'true' : value;
    problems.push(
      ...schemaProblems(c, [...(hPtr ?? [...base, 'headers', name]), 'schema'], typed, `header ${name}`),
    );
  }
  return problems;
}

/**
 * A response of `components.responses.<name>` that no operation lists (e.g. MethodNotAllowed, P3): status, then the
 * same body/header checks as expectContract, plus the problem `code` when given.
 */
export async function expectSharedResponse(
  res: ApiResponse,
  name: string,
  expected: { status: number; code?: string },
): Promise<void> {
  const c = await contract();
  const response = c.doc.components.responses?.[name] as Json | undefined;
  if (!response) throw new Error(`unknown components.responses.${name}`);
  const problems = responseProblems(c, res, response, ['components', 'responses', name]);
  if (res.status !== expected.status) problems.push(`status ${res.status}, expected ${expected.status}`);
  if (expected.code !== undefined) {
    if (res.body?.code !== expected.code)
      problems.push(`body.code ${res.body?.code}, expected ${expected.code}`);
    if (res.body?.type !== problemType(expected.code)) problems.push(`body.type ${res.body?.type}`);
  }
  if (problems.length) throw new ContractViolation(res, `components.responses.${name}`, problems);
}

function problemType(code: string): string {
  return `/problems/${code.toLowerCase().replace(/_/g, '-')}`;
}

/**
 * For responses no operation describes (unknown path, 405, the 12 MiB body limit): an RFC 7807 problem of the
 * contract's `Problem` schema with this status and code, plus the common headers.
 */
export async function expectProblem(res: ApiResponse, status: number, code: string): Promise<void> {
  const c = await contract();
  const problems = commonHeaderProblems(res);
  if (res.status !== status) problems.push(`status ${res.status}, expected ${status}`);
  if (res.contentType !== 'application/problem+json') problems.push(`Content-Type "${res.contentType}"`);
  if (typeof res.body !== 'object' || res.body === null) problems.push('body is not a JSON object');
  else {
    problems.push(...schemaProblems(c, ['components', 'schemas', 'Problem'], res.body, 'body'));
    if (res.body.status !== status) problems.push(`body.status ${res.body.status}`);
    if (res.body.code !== code) problems.push(`body.code ${res.body.code}, expected ${code}`);
    if (res.body.type !== problemType(code)) problems.push(`body.type ${res.body.type}`);
  }
  if (problems.length) throw new ContractViolation(res, `Problem ${status} ${code}`, problems);
}

/** Validates a value against a named component schema (e.g. an outbox payload against its event data, later). */
export async function schemaErrors(name: string, value: unknown): Promise<string[]> {
  const c = await contract();
  return schemaProblems(c, ['components', 'schemas', name], value, name);
}
