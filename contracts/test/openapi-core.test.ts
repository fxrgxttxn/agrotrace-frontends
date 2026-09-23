import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

// Structural invariants of the OpenAPI contract that redocly's ruleset does not check.
// Task 10 adds the full endpoint-list test on top of these.

type Json = Record<string, any>;

const ROOT = fileURLToPath(new URL('../openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../redocly.yaml', import.meta.url));
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;
const ROLE_CODES = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];

// Ruling R5 — exact list and order.
const PROBLEM_CODES = [
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'VERSION_CONFLICT',
  'BUSINESS_RULE',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'ACCOUNT_LOCKED',
  'INVALID_CREDENTIALS',
  'TWO_FACTOR_REQUIRED',
  'INVALID_TWO_FACTOR_CODE',
  'TOKEN_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'INVALID_IDEMPOTENCY_KEY',
  'CAPTCHA_FAILED',
  'GRAPH_CYCLE',
  'BACKEND_UNAVAILABLE',
  'EXTERNAL_UNAVAILABLE',
  'INTERNAL',
];

interface Op {
  id: string; // "post /auth/login"
  pointer: string[]; // ['paths', '/auth/login', 'post']
  op: Json;
}

let doc: Json;
let problems: { severity: string; message: string }[];
let ops: Op[];

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const toRef = (ptr: string[]) =>
  'urn:agrotrace:openapi#/' + ptr.map((p) => encodeURIComponent(esc(p))).join('/');

function deref(node: Json): Json {
  let cur = node;
  for (let guard = 0; cur && typeof cur.$ref === 'string'; guard++) {
    if (guard > 10 || !cur.$ref.startsWith('#/')) throw new Error(`unresolvable ref ${cur.$ref}`);
    cur = cur.$ref
      .slice(2)
      .split('/')
      .map((s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((acc: Json, key: string) => acc?.[key], doc);
  }
  return cur;
}

beforeAll(async () => {
  const config = await loadConfig({ configPath: CONFIG });
  const result = await bundle({ ref: ROOT, config });
  doc = result.bundle.parsed as Json;
  problems = result.problems as any;
  ops = [];
  for (const [path, item] of Object.entries<Json>(doc.paths ?? {})) {
    for (const m of METHODS) {
      if (item[m]) ops.push({ id: `${m} ${path}`, pointer: ['paths', path, m], op: item[m] });
    }
  }
});

describe('openapi contract: bundle', () => {
  it('bundles without errors and leaves no external $ref', () => {
    expect(problems.filter((p) => p.severity === 'error').map((p) => p.message)).toEqual([]);
    const refs: string[] = [];
    (function walk(n: unknown) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === 'object') {
        for (const [k, v] of Object.entries(n)) {
          if (k === '$ref') refs.push(v as string);
          else walk(v);
        }
      }
    })(doc);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !r.startsWith('#/'))).toEqual([]);
    for (const r of new Set(refs)) expect(deref({ $ref: r }), r).toBeTruthy();
  });

  it('is OpenAPI 3.1 served under /api/v1 with bearer security by default', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: '/api/v1' }]);
    expect(doc.security).toEqual([{ bearer: [] }]);
    expect(doc.components.securitySchemes.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('ProblemCode enum equals ruling R5 exactly', () => {
    expect(doc.components.schemas.ProblemCode.enum).toEqual(PROBLEM_CODES);
  });
});

describe('openapi contract: operations', () => {
  it('has operations', () => {
    expect(ops.length).toBeGreaterThan(0);
  });

  it('every operation has a unique camelCase operationId, a summary, tags and x-roles', () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    const tagNames = new Set((doc.tags ?? []).map((t: Json) => t.name));
    for (const { id, op } of ops) {
      if (typeof op.operationId !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(op.operationId))
        bad.push(`${id}: operationId`);
      else if (seen.has(op.operationId)) bad.push(`${id}: duplicate operationId ${op.operationId}`);
      else seen.add(op.operationId);
      if (typeof op.summary !== 'string' || !op.summary.trim() || op.summary.endsWith('.'))
        bad.push(`${id}: summary`);
      if (!Array.isArray(op.tags) || op.tags.length === 0 || !op.tags.every((t: string) => tagNames.has(t)))
        bad.push(`${id}: tags`);
      const roles = op['x-roles'];
      if (!Array.isArray(roles) || roles.length === 0) bad.push(`${id}: x-roles missing`);
      else if (roles.includes('PUBLIC') || roles.includes('ANY')) {
        if (roles.length !== 1) bad.push(`${id}: PUBLIC/ANY must be the only x-roles entry`);
      } else if (!roles.every((r: string) => ROLE_CODES.includes(r)) || new Set(roles).size !== roles.length)
        bad.push(`${id}: x-roles has unknown or duplicate role`);
    }
    expect(bad).toEqual([]);
  });

  it('x-roles ["PUBLIC"] if and only if security: []', () => {
    const bad: string[] = [];
    for (const { id, op } of ops) {
      const isPublic = op['x-roles']?.[0] === 'PUBLIC';
      const noSecurity = Array.isArray(op.security) && op.security.length === 0;
      if (isPublic !== noSecurity) bad.push(id);
    }
    expect(bad).toEqual([]);
  });

  it('every non-public operation documents 401 and 403', () => {
    const bad = ops
      .filter(({ op }) => op['x-roles']?.[0] !== 'PUBLIC')
      .filter(({ op }) => !op.responses?.['401'] || !op.responses?.['403'])
      .map(({ id }) => id);
    expect(bad).toEqual([]);
  });

  it('x-org-admin is only `true` and only on non-public, non-ANY operations', () => {
    const bad = ops
      .filter(({ op }) => 'x-org-admin' in op)
      .filter(({ op }) => op['x-org-admin'] !== true || ['PUBLIC', 'ANY'].includes(op['x-roles']?.[0]))
      .map(({ id }) => id);
    expect(bad).toEqual([]);
  });

  it('every 2xx response documents X-Request-Id and X-Backend headers', () => {
    const bad: string[] = [];
    for (const { id, op } of ops) {
      for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
        if (!/^2\d\d$/.test(code)) continue;
        const headers = deref(resp).headers ?? {};
        if (!headers['X-Request-Id'] || !headers['X-Backend']) bad.push(`${id} ${code}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('error responses use application/problem+json with the Problem schema', () => {
    const bad: string[] = [];
    for (const { id, op } of ops) {
      for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
        if (!/^[45]\d\d$/.test(code) || id.includes('/health/')) continue;
        const media = deref(resp).content?.['application/problem+json'];
        if (media?.schema?.$ref !== '#/components/schemas/Problem') bad.push(`${id} ${code}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('x-idempotent operations require Idempotency-Key and document Idempotent-Replayed', () => {
    const bad: string[] = [];
    for (const { id, op } of ops.filter(({ op }) => op['x-idempotent'] === true)) {
      const params = (op.parameters ?? []).map(deref);
      if (!params.some((p: Json) => p.name === 'Idempotency-Key' && p.in === 'header' && p.required === true))
        bad.push(`${id}: Idempotency-Key`);
      for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
        if (/^2\d\d$/.test(code) && !deref(resp).headers?.['Idempotent-Replayed'])
          bad.push(`${id} ${code}: Idempotent-Replayed`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('upload operations use multipart/form-data with a binary `file` field and document 413/415', () => {
    const uploads = ops.filter(({ op }) => op.requestBody?.content?.['multipart/form-data']);
    expect(uploads.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const { id, op } of uploads) {
      const schema = deref(op.requestBody.content['multipart/form-data'].schema);
      if (!schema.required?.includes('file') || deref(schema.properties?.file ?? {}).type !== 'string')
        bad.push(`${id}: file`);
      if (!op.responses['413'] || !op.responses['415']) bad.push(`${id}: 413/415`);
    }
    expect(bad).toEqual([]);
  });

  it('PublicBatch exposes no personal data fields', () => {
    const forbidden = /email|phone|fullName|userName|inn|contact|createdBy|user/i;
    const found: string[] = [];
    (function walk(schema: Json, path: string) {
      const s = deref(schema);
      for (const [name, sub] of Object.entries<Json>(s.properties ?? {})) {
        if (forbidden.test(name)) found.push(`${path}.${name}`);
        walk(sub, `${path}.${name}`);
      }
      if (s.items) walk(s.items, `${path}[]`);
      for (const k of ['oneOf', 'anyOf', 'allOf']) (s[k] ?? []).forEach((x: Json) => walk(x, path));
    })(doc.components.schemas.PublicBatch, 'PublicBatch');
    expect(found).toEqual([]);
  });
});

describe('openapi contract: examples validate against their schemas', () => {
  let ajv: Ajv2020;
  const cases: { where: string; schemaPtr: string[]; value: unknown }[] = [];

  beforeAll(() => {
    ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, logger: false });
    addFormats(ajv);
    ajv.addFormat('binary', true);
    ajv.addSchema(doc, 'urn:agrotrace:openapi');

    // 1) schema-level `example` anywhere inside components.schemas (not descending into example values)
    (function walk(node: unknown, ptr: string[]) {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, [...ptr, String(i)]));
      if (!node || typeof node !== 'object') return;
      const obj = node as Json;
      // A `properties` map is not a schema: its keys are property names.
      const isPropertiesMap = ptr[ptr.length - 1] === 'properties';
      if (!isPropertiesMap && 'example' in obj) {
        cases.push({ where: ptr.join('/'), schemaPtr: ptr, value: obj.example });
      }
      for (const [k, v] of Object.entries(obj)) {
        if (isPropertiesMap || (k !== 'example' && k !== 'examples')) walk(v, [...ptr, k]);
      }
    })(doc.components.schemas, ['components', 'schemas']);

    // 2) media-type, parameter and header examples
    const collectMedia = (content: Json | undefined, ptr: string[]) => {
      for (const [mt, media] of Object.entries<Json>(content ?? {})) {
        if (!media.schema) continue;
        const sp = [...ptr, mt, 'schema'];
        if ('example' in media)
          cases.push({ where: `${ptr.join('/')}/${mt}/example`, schemaPtr: sp, value: media.example });
        for (const [name, ex] of Object.entries<Json>(media.examples ?? {})) {
          cases.push({
            where: `${ptr.join('/')}/${mt}/examples/${name}`,
            schemaPtr: sp,
            value: deref(ex).value,
          });
        }
      }
    };
    const collectWithSchema = (holder: Json, ptr: string[]) => {
      if (holder && !holder.$ref && holder.schema && 'example' in holder)
        cases.push({ where: ptr.join('/'), schemaPtr: [...ptr, 'schema'], value: holder.example });
    };
    for (const { pointer, op } of ops) {
      if (op.requestBody && !op.requestBody.$ref)
        collectMedia(op.requestBody.content, [...pointer, 'requestBody', 'content']);
      (op.parameters ?? []).forEach((p: Json, i: number) =>
        collectWithSchema(p, [...pointer, 'parameters', String(i)]),
      );
      for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
        if (resp.$ref) continue;
        collectMedia(resp.content, [...pointer, 'responses', code, 'content']);
        for (const [h, hv] of Object.entries<Json>(resp.headers ?? {}))
          collectWithSchema(hv, [...pointer, 'responses', code, 'headers', h]);
      }
    }
    for (const [name, resp] of Object.entries<Json>(doc.components.responses ?? {})) {
      collectMedia(resp.content, ['components', 'responses', name, 'content']);
    }
    for (const [name, p] of Object.entries<Json>(doc.components.parameters ?? {}))
      collectWithSchema(p, ['components', 'parameters', name]);
    for (const [name, h] of Object.entries<Json>(doc.components.headers ?? {}))
      collectWithSchema(h, ['components', 'headers', name]);
  });

  it('collects examples from schemas, media types, parameters and headers', () => {
    expect(cases.length).toBeGreaterThan(50);
    expect(cases.some((c) => c.where.startsWith('paths/'))).toBe(true);
    expect(cases.some((c) => c.where.startsWith('components/responses/'))).toBe(true);
  });

  it('every example is valid', () => {
    const failures: string[] = [];
    for (const c of cases) {
      const validate = ajv.compile({ $ref: toRef(c.schemaPtr) });
      if (!validate(c.value)) failures.push(`${c.where}: ${ajv.errorsText(validate.errors)}`);
    }
    expect(failures).toEqual([]);
  });

  it('every request body and 2xx JSON response has an example (inline or on its schema)', () => {
    const hasExample = (media: Json) => {
      if ('example' in media || media.examples) return true;
      const s = deref(media.schema ?? {});
      return 'example' in s;
    };
    const bad: string[] = [];
    for (const { id, op } of ops) {
      const req = op.requestBody?.content?.['application/json'];
      if (req && !hasExample(req)) bad.push(`${id} request`);
      for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
        const media = deref(resp).content?.['application/json'];
        if (/^2\d\d$/.test(code) && media && !hasExample(media)) bad.push(`${id} ${code}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
