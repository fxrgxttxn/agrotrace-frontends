import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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

const RATE_LIMITS = JSON.parse(readFileSync(new URL('../rules/rate-limits.json', import.meta.url), 'utf8'));

// Expected access per operationId (spec 4.3 + rulings R27/R28/R34). roles ['PUBLIC'] = no auth,
// ['ANY'] = any authenticated user; orgAdmin = x-org-admin; access 'signed' = Bearer or signed URL.
const ALL_ROLES = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const PUBLIC = { roles: ['PUBLIC'] };
const ANY = { roles: ['ANY'] };
const ORG_HEAD = { roles: ALL_ROLES, orgAdmin: true };
const EXPECTED_ACCESS: Record<string, Json> = {
  // Auth
  login: PUBLIC,
  refreshToken: PUBLIC,
  logout: PUBLIC,
  verifyTwoFactor: PUBLIC,
  setupTwoFactor: { roles: ['INSPECTOR', 'ADMIN'] },
  forgotPassword: PUBLIC,
  resetPassword: PUBLIC,
  registerOrganization: PUBLIC,
  acceptInvite: PUBLIC,
  // Profile
  getMe: ANY,
  updateMe: ANY,
  uploadMyAvatar: ANY,
  deleteMyAvatar: ANY,
  getMyChannels: ANY,
  updateMyChannels: ANY,
  createTelegramCode: ANY,
  // Users
  listUsers: ORG_HEAD,
  inviteUser: ORG_HEAD,
  updateUser: ORG_HEAD,
  getUserAvatar: ANY,
  // Organizations
  getOrganization: ANY,
  uploadOrganizationLogo: ORG_HEAD,
  getOrganizationLogo: ANY,
  // Files
  downloadFile: { roles: ['ANY'], access: 'signed' },
  // Public
  getPublicBatch: PUBLIC,
  createPublicComplaint: PUBLIC,
  getCaptchaChallenge: PUBLIC,
  downloadPublicFile: PUBLIC,
  // Health
  getHealthLive: PUBLIC,
  getHealthReady: PUBLIC,
  // Events
  streamEvents: ANY,
};

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

  it('x-roles / x-org-admin / x-access match the expected permission matrix (spec 4.3) exactly', () => {
    const actual: Record<string, Json> = {};
    for (const { op } of ops) {
      actual[op.operationId] = {
        roles: op['x-roles'],
        ...(op['x-org-admin'] ? { orgAdmin: true } : {}),
        ...(op['x-access'] ? { access: op['x-access'] } : {}),
      };
    }
    // Every operation in the contract must be listed; Tasks 9-10 extend this table.
    expect(actual).toEqual(EXPECTED_ACCESS);
  });

  it('access categories: PUBLIC ⇔ security: []; SIGNED ⇔ security [bearer, {}]; others need a credential', () => {
    const bad: string[] = [];
    for (const { id, op } of ops) {
      const isPublic = op['x-roles']?.[0] === 'PUBLIC';
      const isSigned = op['x-access'] === 'signed';
      const sec = op.security;
      const noSecurity = Array.isArray(sec) && sec.length === 0;
      const optionalSecurity = Array.isArray(sec) && sec.some((s: Json) => Object.keys(s).length === 0);
      if (isPublic !== noSecurity) bad.push(`${id}: PUBLIC must have security: [] and vice versa`);
      if (isSigned !== optionalSecurity) bad.push(`${id}: only x-access signed may make security optional`);
      if ('x-access' in op && !isSigned) bad.push(`${id}: unknown x-access`);
      if (isSigned) {
        if (isPublic) bad.push(`${id}: signed operation cannot be PUBLIC`);
        if (JSON.stringify(sec) !== JSON.stringify([{ bearer: [] }, {}])) bad.push(`${id}: signed security`);
        const names = (op.parameters ?? []).map((p: Json) => deref(p).name);
        if (!names.includes('exp') || !names.includes('sig')) bad.push(`${id}: exp/sig params`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('rate-limits.json matches ruling R30 exactly', () => {
    expect(RATE_LIMITS.limits).toEqual([
      {
        scope: 'user',
        limit: 100,
        windowSec: 60,
        subject: 'userId',
        keyPattern: 'rl:user:{userId}:{windowStartEpochSec}',
      },
      {
        scope: 'login-ip',
        limit: 20,
        windowSec: 60,
        subject: 'ip',
        keyPattern: 'rl:login-ip:{ip}:{windowStartEpochSec}',
      },
      {
        scope: 'forgot',
        limit: 3,
        windowSec: 3600,
        subject: 'email',
        keyPattern: 'rl:forgot:{email}:{windowStartEpochSec}',
      },
      {
        scope: 'complaint-ip',
        limit: 10,
        windowSec: 3600,
        subject: 'ip',
        keyPattern: 'rl:complaint-ip:{ip}:{windowStartEpochSec}',
      },
    ]);
  });

  it('429 is documented exactly where a rate-limit scope applies (user scope for every non-public op)', () => {
    const scopes = new Set(RATE_LIMITS.limits.map((l: Json) => l.scope));
    const bad: string[] = [];
    const expectedScopes: Record<string, string[]> = {
      login: ['login-ip'],
      forgotPassword: ['forgot'],
      createPublicComplaint: ['complaint-ip'],
    };
    for (const { id, op } of ops) {
      const rl: string[] = op['x-rate-limit'] ?? [];
      if (!rl.every((s) => scopes.has(s) && s !== 'user')) bad.push(`${id}: unknown x-rate-limit scope`);
      if (JSON.stringify(rl) !== JSON.stringify(expectedScopes[op.operationId] ?? []))
        bad.push(`${id}: x-rate-limit`);
      const isPublic = op['x-roles']?.[0] === 'PUBLIC';
      const limited = !isPublic || rl.length > 0;
      if (limited !== Boolean(op.responses?.['429']))
        bad.push(`${id}: 429 ${limited ? 'missing' : 'unexpected'}`);
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
      const file = deref(schema.properties?.file ?? {});
      if (
        !schema.required?.includes('file') ||
        file.type !== 'string' ||
        (file.format !== 'binary' && typeof file.contentMediaType !== 'string')
      )
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

  it('every object schema inside PublicBatch (recursively) has additionalProperties: false', () => {
    const open: string[] = [];
    let objects = 0;
    (function walk(schema: Json, path: string) {
      const s = deref(schema);
      const isObject =
        s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')) || s.properties;
      if (isObject) {
        objects++;
        if (s.additionalProperties !== false) open.push(path);
      }
      for (const [name, sub] of Object.entries<Json>(s.properties ?? {})) walk(sub, `${path}.${name}`);
      if (s.items) walk(s.items, `${path}[]`);
      for (const k of ['oneOf', 'anyOf', 'allOf']) (s[k] ?? []).forEach((x: Json) => walk(x, path));
    })(doc.components.schemas.PublicBatch, 'PublicBatch');
    expect(objects).toBeGreaterThanOrEqual(6);
    expect(open).toEqual([]);
  });
});

describe('openapi contract: examples validate against their schemas', () => {
  let ajv: Ajv2020;
  const cases: { where: string; schemaPtr: string[]; value: unknown }[] = [];

  beforeAll(() => {
    // Strict schema mode: an unknown `format` (or keyword) makes compilation throw instead of being ignored.
    ajv = new Ajv2020({
      strict: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allErrors: true,
      validateFormats: true,
    });
    addFormats(ajv);
    ajv.addFormat('binary', true);
    // OpenAPI annotation keywords allowed inside schemas.
    ajv.addVocabulary(['example', 'discriminator', 'xml', 'externalDocs']);
    // Top-level OpenAPI document fields (the bundle is registered as one schema so refs resolve).
    ajv.addVocabulary(['openapi', 'info', 'servers', 'security', 'tags', 'paths', 'components']);
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
      if (!isPropertiesMap && Array.isArray(obj.examples)) {
        obj.examples.forEach((value: unknown, i: number) =>
          cases.push({ where: `${ptr.join('/')}/examples/${i}`, schemaPtr: ptr, value }),
        );
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
