import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { bundle, loadConfig } from '@redocly/openapi-core';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

type Json = Record<string, any>;

const ROOT = fileURLToPath(new URL('../openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../redocly.yaml', import.meta.url));
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;
const ROLE_CODES = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];

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
  'NO_LAB_AVAILABLE',
  'IDEMPOTENCY_KEY_IN_PROGRESS',
  'REFERENCE_IN_USE',
  'METHOD_NOT_ALLOWED',
];

const RATE_LIMITS = JSON.parse(readFileSync(new URL('../rules/rate-limits.json', import.meta.url), 'utf8'));

const ALL_ROLES = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const PUBLIC = { roles: ['PUBLIC'] };
const ANY = { roles: ['ANY'] };
const ORG_HEAD = { roles: ALL_ROLES, orgAdmin: true };
const FARMER_ONLY = { roles: ['FARMER'] };
const FIELDS_READ = { roles: ['FARMER', 'INSPECTOR', 'ADMIN'] };
const WAYBILLS_READ = { roles: ['FARMER', 'PROCESSOR', 'RETAILER', 'INSPECTOR', 'ADMIN'] };
const WAYBILL_SENDERS = { roles: ['FARMER', 'PROCESSOR'] };
const WAYBILL_RECEIVERS = { roles: ['PROCESSOR', 'RETAILER'] };
const STATE_MACHINE = JSON.parse(
  readFileSync(new URL('../rules/state-machine.json', import.meta.url), 'utf8'),
);
const EXPECTED_ACCESS: Record<string, Json> = {
  login: PUBLIC,
  refreshToken: PUBLIC,
  logout: PUBLIC,
  verifyTwoFactor: PUBLIC,
  setupTwoFactor: { roles: ['INSPECTOR', 'ADMIN'] },
  forgotPassword: PUBLIC,
  resetPassword: PUBLIC,
  registerOrganization: PUBLIC,
  acceptInvite: PUBLIC,
  getMe: ANY,
  updateMe: ANY,
  uploadMyAvatar: ANY,
  deleteMyAvatar: ANY,
  getMyChannels: ANY,
  updateMyChannels: ANY,
  createTelegramCode: ANY,
  listUsers: ORG_HEAD,
  inviteUser: ORG_HEAD,
  updateUser: ORG_HEAD,
  getUserAvatar: ANY,
  getOrganization: ANY,
  listOrganizations: ANY,
  uploadOrganizationLogo: ORG_HEAD,
  getOrganizationLogo: ANY,
  downloadFile: { roles: ['ANY'], access: 'signed' },
  getPublicBatch: PUBLIC,
  createPublicComplaint: PUBLIC,
  getCaptchaChallenge: PUBLIC,
  downloadPublicFile: PUBLIC,
  getHealthLive: PUBLIC,
  getHealthReady: PUBLIC,
  streamEvents: ANY,
  listFields: FIELDS_READ,
  createField: FARMER_ONLY,
  getField: FIELDS_READ,
  updateField: FARMER_ONLY,
  deleteField: FARMER_ONLY,
  listFieldTreatments: FIELDS_READ,
  createTreatment: FARMER_ONLY,
  updateTreatment: FARMER_ONLY,
  listBatches: ANY,
  createBatch: FARMER_ONLY,
  getBatch: ANY,
  getBatchGraph: ANY,
  getBatchHistory: ANY,
  getBatchPath: ANY,
  getBatchDocuments: ANY,
  retryBatchVsdImport: { roles: ['FARMER', 'PROCESSOR'] },
  createBatchQr: { roles: ['PROCESSOR', 'RETAILER'] },
  downloadBatchQr: { roles: ['PROCESSOR', 'RETAILER'] },
  putBatchOnSale: { roles: ['RETAILER'] },
  markBatchSold: { roles: ['RETAILER'] },
  processBatches: { roles: ['PROCESSOR'] },
  listWaybills: WAYBILLS_READ,
  createWaybill: WAYBILL_SENDERS,
  getWaybill: WAYBILLS_READ,
  sendWaybill: WAYBILL_SENDERS,
  deleteWaybill: WAYBILL_SENDERS,
  acceptWaybill: WAYBILL_RECEIVERS,
  rejectWaybill: WAYBILL_RECEIVERS,
  listPublicRegions: PUBLIC,
  listLabTests: ANY,
  createLabTest: { roles: ['INSPECTOR'] },
  getLabTest: ANY,
  registerLabSample: { roles: ['LAB'] },
  submitLabResults: { roles: ['LAB'] },
  uploadLabProtocol: { roles: ['LAB'] },
  downloadLabProtocol: ANY,
  listRecalls: { roles: ['INSPECTOR', 'ADMIN'] },
  createRecall: { roles: ['INSPECTOR'] },
  getRecall: { roles: ['INSPECTOR', 'ADMIN'] },
  getRecallGraph: { roles: ['INSPECTOR', 'ADMIN'] },
  listRecallTasks: { roles: ['FARMER', 'PROCESSOR', 'RETAILER', 'INSPECTOR'] },
  confirmRecallTask: { roles: ['FARMER', 'PROCESSOR', 'RETAILER'] },
  listComplaints: { roles: ['INSPECTOR'] },
  getComplaint: { roles: ['INSPECTOR'] },
  startComplaintReview: { roles: ['INSPECTOR'] },
  decideComplaint: { roles: ['INSPECTOR'] },
  listNotifications: ANY,
  markNotificationsRead: ANY,
  getDashboard: ANY,
  downloadReport: { roles: ALL_ROLES },
  listAdminOrganizations: { roles: ['ADMIN'] },
  updateAdminOrganization: { roles: ['ADMIN'] },
  approveOrganization: { roles: ['ADMIN'] },
  listAuditLog: { roles: ['INSPECTOR', 'ADMIN'] },
  listDictionary: ANY,
  createDictionaryEntry: { roles: ['ADMIN'] },
  updateDictionaryEntry: { roles: ['ADMIN'] },
  deleteDictionaryEntry: { roles: ['ADMIN'] },
  importDictionary: { roles: ['ADMIN'] },
  uploadProductImage: { roles: ['ADMIN'] },
};

const EXPECTED_IDEMPOTENT = [
  'createWaybill',
  'sendWaybill',
  'acceptWaybill',
  'confirmRecallTask',
  'retryBatchVsdImport',
];

const EXPECTED_REPORT_ACCESS = {
  batches: { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['FARMER', 'PROCESSOR', 'RETAILER'] },
  recalls: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  recall: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  'lab-tests': { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['LAB'] },
  complaints: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  org: { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER'] },
};

const EXPECTED_IF_MATCH = [
  'putBatchOnSale',
  'markBatchSold',
  'sendWaybill',
  'acceptWaybill',
  'rejectWaybill',
  'deleteWaybill',
  'registerLabSample',
  'submitLabResults',
  'confirmRecallTask',
];

const RULE_PARAMS: Record<string, string[]> = {
  'BR-01': ['publicCode', 'until', 'substance'],
  'BR-04': ['inputKg', 'allowedKg', 'outputKg'],
  'BR-05': ['publicCode', 'status'],
  'BR-06': ['publicCode', 'status'],
  'BR-07': ['publicCode', 'percent'],
};
const EXPECTED_RULES: Record<string, string[]> = {
  sendWaybill: ['BR-01', 'BR-06'],
  acceptWaybill: ['BR-06', 'BR-07'],
  processBatches: ['BR-04', 'BR-05', 'BR-06'],
};

const FORBIDDEN_PARAMS: Record<string, string[][]> = {
  USER_BLOCKED: [['reason']],
  USER_INVITED: [['reason']],
  ORGANIZATION_NOT_ACTIVE: [['reason']],
  NOT_HOLDER: [['reason'], ['reason', 'publicCode']],
  NOT_SENDER: [['reason']],
  NOT_RECEIVER: [['reason']],
  EDIT_WINDOW_CLOSED: [['reason', 'editableUntil']],
  BATCH_STATUS: [['reason', 'status']],
};

const EXPECTED_LOCKS: Record<string, string[]> = {
  createWaybill: ['batches'],
  sendWaybill: ['waybill', 'batches'],
  acceptWaybill: ['waybill', 'batches'],
  rejectWaybill: ['waybill', 'batches', 'recallTasks'],
  deleteWaybill: ['waybill'],
  putBatchOnSale: ['batches'],
  markBatchSold: ['batches'],
  createBatchQr: ['batches'],
  processBatches: ['batches'],
  registerLabSample: ['labTest'],
  submitLabResults: ['labTest', 'batches'],
  uploadLabProtocol: ['labTest'],
  createRecall: ['batches'],
  confirmRecallTask: ['recall', 'batches', 'recallTasks'],
  startComplaintReview: ['complaint'],
  decideComplaint: ['complaint', 'batches'],
  updateAdminOrganization: ['organization'],
  approveOrganization: ['organization'],
  retryBatchVsdImport: ['batches', 'batchDocument'],
};

const LOCK_ORDER = [
  'waybill',
  'recall',
  'labTest',
  'complaint',
  'organization',
  'batches',
  'recallTasks',
  'batchDocument',
];

const ENVELOPE = JSON.parse(readFileSync(new URL('../events/envelope.schema.json', import.meta.url), 'utf8'));
const ENTITY_SM = JSON.parse(
  readFileSync(new URL('../rules/entity-state-machines.json', import.meta.url), 'utf8'),
);
const TRANSITION_STATUSES_BY_OP: Record<string, () => string[]> = {
  updateUser: () => doc.components.schemas.UserStatus.enum,
  updateAdminOrganization: () => ENTITY_SM.organization.statuses,
};

const WAYBILL_SM = JSON.parse(
  readFileSync(new URL('../rules/waybill-state-machine.json', import.meta.url), 'utf8'),
);

const CLOSED_SCHEMAS = [
  'GeoJsonPolygon',
  'Field',
  'FieldInput',
  'FieldPage',
  'Treatment',
  'TreatmentInput',
  'TreatmentPage',
  'BatchAction',
  'BatchListItem',
  'BatchPage',
  'Batch',
  'BatchCreate',
  'BatchGraph',
  'StatusHistoryItem',
  'PathStep',
  'QrRequest',
  'QrLinks',
  'ProcessingRequest',
  'ProcessingResult',
  'WaybillItem',
  'Waybill',
  'WaybillPage',
  'WaybillCreate',
  'WaybillAccept',
  'WaybillReject',
  'OrganizationDirectoryPage',
  'BatchDocuments',
  'BatchVsd',
  'VsdDocument',
  'LabProtocolDocument',
  'LabTestPage',
  'LabTest',
  'LabTestCreate',
  'LabSampleRequest',
  'LabResultsInput',
  'RecallTaskPage',
  'RecallTaskConfirm',
  'RecallPage',
  'Recall',
  'RecallCreate',
  'RecallGraph',
  'ComplaintPage',
  'Complaint',
  'ComplaintReviewRequest',
  'ComplaintDecision',
  'Dashboard',
  'OrganizationAdminPage',
  'OrganizationAdminPatch',
  'AuditPage',
  'DictionaryPage',
  'DictionaryInput',
  'ImportReport',
  'NotificationPage',
  'MarkReadRequest',
  'ProtocolUpload',
  'ImportUpload',
];
const OPEN_BY_DESIGN = ['AuditPage.items[].diff', 'NotificationPage.items[].payload'];

interface Op {
  id: string;
  pointer: string[];
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

  it('ProblemCode enum equals R5 exactly', () => {
    expect(doc.components.schemas.ProblemCode.enum).toEqual(PROBLEM_CODES);
  });

  it('P7: body-level errors use the `_root` key; duplicates sit at the repeated element', () => {
    const d: string = doc.info.description;
    expect(d).toMatch(/Ключ `_root` — ошибки тела целиком \(P7\)/);
    expect(d).toMatch(/не разбирается как JSON[^.]*400 VALIDATION `errors\._root: \[validation\.invalid\]`/);
    expect(d).toMatch(/`errors\._root: \[validation\.type\]`/);
    expect(d).toMatch(/повтор элемента массива — у поля повторившегося элемента/);
  });

  it('P3: 405 METHOD_NOT_ALLOWED is a shared response with the Allow header, described in info', () => {
    const r = doc.components.responses.MethodNotAllowed;
    expect(r.content['application/problem+json'].example).toMatchObject({
      type: '/problems/method-not-allowed',
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
    });
    expect(Object.keys(r.headers)).toEqual(['Allow', 'X-Request-Id', 'X-Backend']);
    expect(doc.components.headers.Allow.schema.pattern).toBe('^[A-Z]+(, [A-Z]+)*$');
    expect(doc.info.description).toMatch(/405 METHOD_NOT_ALLOWED с заголовком `Allow`/);
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

  it('rate-limits.json matches R30 exactly', () => {
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

  it('BatchStatus and BatchActionName enums equal contracts/rules/state-machine.json', () => {
    expect(doc.components.schemas.BatchStatus.enum).toEqual(STATE_MACHINE.statuses);
    const actions = [...new Set(STATE_MACHINE.transitions.map((t: Json) => t.action))];
    expect(doc.components.schemas.BatchActionName.enum).toEqual(actions);
  });

  it('x-idempotent is set exactly on the expected operations', () => {
    const actual = ops.filter(({ op }) => op['x-idempotent'] === true).map(({ op }) => op.operationId);
    expect(actual.sort()).toEqual([...EXPECTED_IDEMPOTENT].sort());
    const bad = ops
      .filter(({ op }) => 'x-idempotent' in op && op['x-idempotent'] !== true)
      .map(({ id }) => id);
    expect(bad).toEqual([]);
  });

  it('If-Match is required exactly on the expected operations, which document 409 VERSION_CONFLICT', () => {
    const withIfMatch = ops.filter(({ op }) =>
      (op.parameters ?? []).map(deref).some((p: Json) => p.name === 'If-Match'),
    );
    expect(withIfMatch.map(({ op }) => op.operationId).sort()).toEqual([...EXPECTED_IF_MATCH].sort());
    const bad: string[] = [];
    for (const { id, op } of withIfMatch) {
      const p = (op.parameters ?? []).map(deref).find((x: Json) => x.name === 'If-Match');
      if (p.in !== 'header' || p.required !== true || p.schema?.type !== 'integer')
        bad.push(`${id}: If-Match`);
      const conflict = op.responses?.['409'];
      if (!conflict) {
        bad.push(`${id}: 409 missing`);
        continue;
      }
      const media = deref(conflict).content?.['application/problem+json'] ?? {};
      const examples = [
        ...('example' in media ? [media.example] : []),
        ...Object.values<Json>(media.examples ?? {}).map((e) => deref(e).value),
      ];
      if (!examples.some((e) => e.code === 'VERSION_CONFLICT')) bad.push(`${id}: VERSION_CONFLICT example`);
    }
    expect(bad).toEqual([]);
  });

  const problemExamples = (op: Json, code: string): Json[] => {
    const resp = op.responses?.[code];
    if (!resp) return [];
    const media = deref(resp).content?.['application/problem+json'] ?? {};
    return [
      ...('example' in media ? [media.example] : []),
      ...Object.values<Json>(media.examples ?? {}).map((e) => deref(e).value),
    ];
  };

  it('422 is documented exactly for the expected rules, one example per rule with exact params keys', () => {
    const bad: string[] = [];
    for (const { id, op } of ops) {
      const expected = EXPECTED_RULES[op.operationId] ?? [];
      if (Boolean(op.responses?.['422']) !== expected.length > 0) {
        bad.push(`${id}: 422 ${expected.length ? 'missing' : 'unexpected'}`);
        continue;
      }
      if (!expected.length) continue;
      const examples = problemExamples(op, '422');
      const rules = examples.map((e) => e.rule);
      if (JSON.stringify([...new Set(rules)].sort()) !== JSON.stringify([...expected].sort()))
        bad.push(`${id}: rules ${rules.join(',')} != ${expected.join(',')}`);
      for (const e of examples) {
        if (e.code !== 'BUSINESS_RULE' || e.status !== 422) bad.push(`${id}: ${e.rule} code/status`);
        const keys = Object.keys(e.params ?? {}).sort();
        if (JSON.stringify(keys) !== JSON.stringify([...(RULE_PARAMS[e.rule] ?? ['?'])].sort()))
          bad.push(`${id}: ${e.rule} params ${keys.join(',')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('403/409 problem examples use the documented params keys and transition targets', () => {
    const bad: string[] = [];
    const batchStatuses: string[] = STATE_MACHINE.statuses;
    let noLabOnCreateBatch = false;
    let referenceInUse = 0;
    for (const { id, op } of ops) {
      const hasIfMatch = (op.parameters ?? []).map(deref).some((p: Json) => p.name === 'If-Match');
      const tr = op['x-transition'];
      for (const e of problemExamples(op, '409')) {
        const keys = JSON.stringify(Object.keys(e.params ?? {}).sort());
        if (
          e.code === 'VERSION_CONFLICT' &&
          (hasIfMatch || 'x-locks' in op) &&
          keys !== (hasIfMatch ? '["currentVersion"]' : '[]')
        )
          bad.push(`${id}: VERSION_CONFLICT params ${keys} (If-Match: ${hasIfMatch})`);
        if (e.code === 'INVALID_TRANSITION') {
          if (keys === '["from","publicCode","to"]') {
            if (!batchStatuses.includes(e.params.to) || !batchStatuses.includes(e.params.from))
              bad.push(`${id}: batch INVALID_TRANSITION ${e.params.from}->${e.params.to}`);
          } else if (keys === '["from","to"]') {
            const entityStatuses: string[] | undefined = !tr
              ? TRANSITION_STATUSES_BY_OP[op.operationId]?.()
              : tr.entity === 'waybill'
                ? WAYBILL_SM.statuses
                : tr.entity === 'batch'
                  ? batchStatuses
                  : ENTITY_SM[tr.entity]?.statuses;
            const allowedTo: string[] = tr ? [tr.to] : (entityStatuses ?? []);
            const allowedFrom: string[] = entityStatuses ?? [];
            if (!allowedTo.includes(e.params.to) || !allowedFrom.includes(e.params.from))
              bad.push(`${id}: INVALID_TRANSITION ${e.params.from}->${e.params.to}`);
          } else bad.push(`${id}: INVALID_TRANSITION params ${keys}`);
        }
        if (e.code === 'GRAPH_CYCLE' && keys !== '["childCode","parentCode"]')
          bad.push(`${id}: GRAPH_CYCLE params`);
        if (e.code === 'NO_LAB_AVAILABLE') {
          if (keys !== '[]' || op.operationId !== 'createBatch')
            bad.push(`${id}: NO_LAB_AVAILABLE only on createBatch, without params (R42)`);
          else noLabOnCreateBatch = true;
        }
        if (e.code === 'IDEMPOTENCY_KEY_REUSED' || e.code === 'IDEMPOTENCY_KEY_IN_PROGRESS') {
          if (keys !== '[]' || op['x-idempotent'] !== true) bad.push(`${id}: ${e.code}`);
        }
        if (e.code === 'REFERENCE_IN_USE') {
          if (keys !== '["usedBy"]' || op.operationId !== 'deleteDictionaryEntry')
            bad.push(`${id}: REFERENCE_IN_USE only on deleteDictionaryEntry with params {usedBy}`);
          else referenceInUse++;
        }
      }
      for (const e of problemExamples(op, '403')) {
        if (e.code !== 'FORBIDDEN') bad.push(`${id}: 403 code ${e.code}`);
        if (e.params === undefined) continue;
        const allowed = FORBIDDEN_PARAMS[e.params.reason];
        const keys = JSON.stringify(Object.keys(e.params).sort());
        if (!allowed || !allowed.map((k) => JSON.stringify([...k].sort())).includes(keys))
          bad.push(`${id}: 403 params ${keys} for reason ${e.params.reason}`);
      }
    }
    if (!noLabOnCreateBatch) bad.push('createBatch: NO_LAB_AVAILABLE example missing (R42)');
    if (referenceInUse !== 1) bad.push('deleteDictionaryEntry: REFERENCE_IN_USE example missing');
    expect(bad).toEqual([]);
  });

  it('x-locks (R47) are declared exactly on the expected operations, which document lock-retry 409', () => {
    const actual: Record<string, string[]> = {};
    const bad: string[] = [];
    for (const { id, op } of ops) {
      if (!('x-locks' in op)) continue;
      actual[op.operationId] = op['x-locks'];
      const idx = (op['x-locks'] as string[]).map((l) => LOCK_ORDER.indexOf(l));
      if (idx.some((i, k) => i < 0 || (k > 0 && i <= idx[k - 1]!)))
        bad.push(`${id}: x-locks ${op['x-locks']} violate the R52 order ${LOCK_ORDER.join(' → ')}`);
      const codes = problemExamples(op, '409').map((e) => e.code);
      if (!codes.includes('VERSION_CONFLICT')) bad.push(`${id}: 409 VERSION_CONFLICT example`);
      const desc: string = op.description ?? '';
      if (!/Блокировки \(R47[,)]/.test(desc))
        bad.push(`${id}: description must reference the R47 locking protocol`);
    }
    expect(actual).toEqual(EXPECTED_LOCKS);
    expect(bad).toEqual([]);
    expect(doc.info.description).toMatch(/READ COMMITTED/);
    expect(doc.info.description).toMatch(/40P01/);
  });

  it('idempotent operations document 409 IDEMPOTENCY_KEY_REUSED and IN_PROGRESS with Retry-After (R48)', () => {
    const bad: string[] = [];
    for (const { id, op } of ops.filter(({ op }) => op['x-idempotent'] === true)) {
      const codes = problemExamples(op, '409').map((e) => e.code);
      for (const c of ['IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_KEY_IN_PROGRESS'])
        if (!codes.includes(c)) bad.push(`${id}: ${c} example`);
      const ra = deref(deref(op.responses['409']).headers?.['Retry-After'] ?? {});
      if (ra.schema?.const !== 1 || ra.required === true) bad.push(`${id}: optional Retry-After const 1`);
    }
    expect(bad).toEqual([]);
  });

  it('waybill and batch transitions (x-transition) match the rules files', () => {
    expect(doc.components.schemas.WaybillStatus.enum).toEqual(WAYBILL_SM.statuses);
    const wActions = WAYBILL_SM.transitions.map((t: Json) => t.action);
    expect(doc.components.schemas.WaybillActionName.enum).toEqual(wActions);
    const bad: string[] = [];
    const seen: string[] = [];
    const seenEntity = new Set<string>();
    for (const { id, op } of ops) {
      const tr = op['x-transition'];
      if (!tr) continue;
      const sm =
        tr.entity === 'waybill' ? WAYBILL_SM : tr.entity === 'batch' ? STATE_MACHINE : ENTITY_SM[tr.entity];
      const match = sm?.transitions.filter((t: Json) => t.action === tr.action && t.to === tr.to) ?? [];
      if (!match.length) bad.push(`${id}: ${tr.entity}.${tr.action} -> ${tr.to} not in rules`);
      if (ENTITY_SM[tr.entity] && !match.every((t: Json) => t.by === op.operationId))
        bad.push(`${id}: ${tr.entity}.${tr.action} is performed by another operation`);
      if (tr.entity === 'waybill') seen.push(tr.action);
      else seenEntity.add(`${tr.entity}.${tr.action}.${op.operationId}`);
    }
    for (const [entity, sm] of Object.entries<Json>(ENTITY_SM)) {
      if (entity === 'description') continue;
      for (const t of sm.transitions as Json[]) {
        if (t.by === 'system' || t.by === 'updateAdminOrganization') continue;
        if (!seenEntity.has(`${entity}.${t.action}.${t.by}`))
          bad.push(`${t.by}: x-transition ${entity}.${t.action} missing`);
      }
    }
    expect(bad).toEqual([]);
    expect(seen.sort()).toEqual([...wActions].sort());
    const withIfMatch = ops
      .filter(({ op }) => (op.parameters ?? []).map(deref).some((p: Json) => p.name === 'If-Match'))
      .filter(({ op }) => !op['x-transition'])
      .map(({ id }) => id);
    expect(withIfMatch).toEqual([]);
  });

  it('listBatches has origin=me|all and orgId filters (R49)', () => {
    const op = ops.find(({ op }) => op.operationId === 'listBatches')!.op;
    const params = Object.fromEntries((op.parameters ?? []).map(deref).map((p: Json) => [p.name, p]));
    expect(params.origin?.schema).toEqual({ type: 'string', enum: ['me', 'all'], default: 'all' });
    expect(params.orgId?.schema).toEqual({ type: 'string', format: 'uuid' });
    expect(op.description).toMatch(/validation\.orgId\.notAllowed/);
  });

  it('role-restricted filters are rejected with validation.<param>.notAllowed, never ignored (R51)', () => {
    const restricted: [string, string][] = [
      ['listFields', 'organizationId'],
      ['listUsers', 'organizationId'],
      ['listWaybills', 'direction'],
      ['listBatches', 'orgId'],
      ['listLabTests', 'labOrgId'],
      ['listRecallTasks', 'holderOrgId'],
      ['listDictionary', 'includeDeleted'],
      ['getDashboard', 'scope'],
    ];
    const bad: string[] = [];
    for (const [opId, param] of restricted) {
      const op = ops.find(({ op }) => op.operationId === opId)?.op;
      const text = JSON.stringify([op?.description, ...(op?.parameters ?? []).map(deref)]);
      if (
        !text.includes(`validation.${param}.notAllowed`) &&
        !text.includes('validation.<параметр>.notAllowed')
      )
        bad.push(`${opId}: ${param}`);
    }
    for (const { id, op } of ops.filter(({ op }) => 'x-sort' in op)) {
      const text = JSON.stringify([op.description, ...(op.parameters ?? []).map(deref)]);
      if (/игнорируется|учитывается только/.test(text)) bad.push(`${id}: silently ignored filter`);
    }
    expect(bad).toEqual([]);
  });

  it('downloadReport declares x-report-access per ReportType; its roles union equals x-roles', () => {
    const op = ops.find(({ op }) => op.operationId === 'downloadReport')!.op;
    expect(op['x-report-access']).toEqual(EXPECTED_REPORT_ACCESS);
    expect(Object.keys(op['x-report-access']).sort()).toEqual(
      [...doc.components.schemas.ReportType.enum].sort(),
    );
    const union = new Set(
      Object.values<Json>(op['x-report-access']).flatMap((a) => [...a.roles, ...a.headRoles]),
    );
    expect([...union].sort()).toEqual([...op['x-roles']].sort());
  });

  it('Dashboard is a oneOf discriminated by scope with one variant per DashboardScope', () => {
    const d = doc.components.schemas.Dashboard;
    expect(d.discriminator.propertyName).toBe('scope');
    const consts = (d.oneOf as Json[]).map((v) => deref(v).properties.scope.const);
    expect(consts.sort()).toEqual([...doc.components.schemas.DashboardScope.enum].sort());
    for (const [k, ref] of Object.entries<string>(d.discriminator.mapping))
      expect(deref({ $ref: ref }).properties.scope.const).toBe(k);
  });

  it('texts: R57 lab recall link, R58 import codes, R59 minors', () => {
    const s = doc.components.schemas;
    const opDesc = (id: string) => ops.find(({ op }) => op.operationId === id)!.op.description as string;
    const bad: string[] = [];
    const must = (name: string, text: string, re: RegExp) => {
      if (!re.test(text)) bad.push(`${name}: ${re}`);
    };
    must('LabTest.recallId', s.LabTest.properties.recallId.description ?? '', /lab_tests\.recall_id/);
    must('submitLabResults', opDesc('submitLabResults'), /lab_tests\.recall_id/);
    must('ImportUpload', s.ImportUpload.description, /NUL/);
    must('ImportUpload', s.ImportUpload.description, /validation\.import\.format/);
    must('importDictionary', opDesc('importDictionary'), /численно/);
    must('importDictionary', opDesc('importDictionary'), /первая по порядку файла/);
    must('info', doc.info.description, /`complaint` → `organization` → `batches`/);
    must(
      'Recalls tag',
      doc.tags.find((t: Json) => t.name === 'Recalls').description,
      /мягко удалённые[^.]*проходит/i,
    );
    must(
      'Recalls tag',
      doc.tags.find((t: Json) => t.name === 'Recalls').description,
      /RECALL `\{event: CLOSED\}`/,
    );
    must('downloadReport', opDesc('downloadReport'), /усекаются до минут/);
    if (/\| Контакт \|/.test(opDesc('downloadReport')))
      bad.push('downloadReport: complaints report must not have a contact column');
    if (/eventId/.test(JSON.stringify(s.Notification))) bad.push('Notification: eventId removed by R56');
    const rules = JSON.parse(readFileSync(new URL('../rules/notifications.json', import.meta.url), 'utf8'));
    if (!rules.types.RECALL.producedBy.some((p: string) => /vacuous/.test(p)))
      bad.push('notifications.json: RECALL CLOSED on vacuous close');
    if (/eventId/.test(JSON.stringify(rules))) bad.push('notifications.json: eventId removed by R56');
    expect(bad).toEqual([]);
  });

  it('R81: Mercury VSD import — createBatch step, documents operations, product code', () => {
    const s = doc.components.schemas;
    const op = (id: string) => ops.find(({ op }) => op.operationId === id)!.op;
    expect(op('createBatch').description).toMatch(/DAIRY или MEAT[^.]*batch_documents[^.]*PENDING/);
    expect(op('createBatch').description).toMatch(/vsd\.import/);
    expect(op('createBatch').description).toMatch(/на статус партии не влияет/);
    const retry = op('retryBatchVsdImport');
    expect(retry.description).toMatch(/NOT_FOUND или FAILED/);
    expect(retry.description).toMatch(/NOT_HOLDER/);
    expect(retry.description).toMatch(/`vsd\.import`/);
    expect(Object.keys(retry.responses)).toContain('202');
    expect(retry.requestBody).toBeUndefined();
    const docs = op('getBatchDocuments');
    expect(deref(docs.responses['200']).content['application/json'].schema.$ref).toBe(
      '#/components/schemas/BatchDocuments',
    );
    expect(s.BatchDocuments.required).toEqual(['batchId', 'vsd', 'labProtocols', 'qr']);
    expect(s.Product.required).toContain('mercuryCode');
    expect(s.ProductInput.required).not.toContain('mercuryCode');
    expect(doc.info.description).toMatch(/`batchDocument`/);
  });

  it('R91: getBatchDocuments filters labProtocols by lab-test visibility and qr by QR download rights', () => {
    const op = ops.find(({ op }) => op.operationId === 'getBatchDocuments')!.op;
    const d: string = op.description;
    expect(d).toMatch(/R91/);
    expect(d).toMatch(/`labProtocols` — только анализы, видимые ему по правилам тега Lab/);
    expect(d).toMatch(/LAB — только анализы своей лаборатории/);
    expect(d).toMatch(/`qr` — только если пользователь может скачать QR[^.]*`downloadBatchQr`/);
    expect(d).toMatch(/иначе null, даже если QR генерировался/);
    expect(doc.components.schemas.BatchDocuments.description).toMatch(/R91/);
    const ex = op.responses['200'].content['application/json'].examples;
    expect(Object.keys(ex)).toEqual(['holder', 'lab']);
    expect(ex.holder.value.qr).not.toBeNull();
    expect(ex.lab.value.qr).toBeNull();
    const labId = ex.lab.value.labProtocols.map((p: Json) => p.lab.id);
    expect(new Set(labId).size).toBe(1);
    expect(ex.holder.value.labProtocols.length).toBeGreaterThan(ex.lab.value.labProtocols.length);
  });

  it('R92: shared Redis residuals — tg:poller compare-and-PEXPIRE, pub:batch verbatim + invalidation list, GETDEL after validation', () => {
    const d: string = doc.info.description;
    const row = (key: string) => d.split('\n').find((l) => l.trim().startsWith(`| \`${key}\` |`))!;
    expect(row('tg:poller')).toMatch(/compare-and-PEXPIRE/);
    expect(row('tg:poller')).toMatch(/redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\][^|]*PEXPIRE/);
    const pub = row('pub:batch:{publicCode}');
    expect(pub).toMatch(/сохранённые байты отдаются как есть/);
    expect(pub).not.toMatch(/предков|потомков/);
    for (const opId of [
      'updateDictionaryEntry',
      'importDictionary',
      'uploadProductImage',
      'updateAdminOrganization',
      'uploadOrganizationLogo',
    ])
      expect(pub).toContain(`\`${opId}\``);
    expect(row('pwreset:{sha256hex(token)}')).toMatch(/GETDEL[^|]*после проверки тела/);
    expect(row('invite:{sha256hex(token)}')).toMatch(/GETDEL[^|]*после проверки тела/);
    const opDesc = (id: string): string => ops.find(({ op }) => op.operationId === id)!.op.description;
    expect(opDesc('resetPassword')).toMatch(
      /Сначала тело проверяется по схеме[^.]*не расходуется\), и только затем\s+токен читается `GETDEL`/,
    );
    expect(opDesc('acceptInvite')).toMatch(
      /Сначала тело проверяется по схеме[^.]*и только затем токен читается `GETDEL`/,
    );
    expect(opDesc('getPublicBatch')).toMatch(/сохранённые байты как есть/);
    expect(d).toMatch(/сравниваются по кодовым точкам Unicode[^.]*COLLATE "C"/);
    expect(opDesc('createBatch')).toMatch(/наименьший `id` \(как текст, по кодовым точкам\)/);
  });

  it('R82: info.description has the shared Redis keys table with exact values and TTLs', () => {
    const d: string = doc.info.description;
    const rows = new Map(
      d
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\| `[^`]+` \|/.test(l))
        .map((l) => {
          const cells = l.split(' | ').map((c) => c.replace(/^\| ?| ?\|$/g, '').trim());
          return [cells[0]!.replace(/`/g, ''), cells] as const;
        }),
    );
    const expected: [string, RegExp, string, RegExp][] = [
      ['pub:batch:{publicCode}', /точный JSON `PublicBatch`/, '300', /после коммита[^|]*каскад отзыва/],
      ['pwreset:{sha256hex(token)}', /"userId"[^|]*"exp"/, '3600', /GETDEL/],
      ['invite:{sha256hex(token)}', /"userId"[^|]*"exp"/, '604800', /GETDEL/],
      ['tgcode:{code}', /\{"userId": "<uuid>"\}/, '600', /createTelegramCode/],
      ['totp-used:{userId}:{step}', /"1"/, '90', /SET NX EX 90/],
      ['tg:poller', /поллер/, '30', /SET NX EX 30[^|]*10 с/],
    ];
    const bad: string[] = [];
    for (const [key, value, ttl, how] of expected) {
      const row = rows.get(key);
      if (!row) {
        bad.push(`${key}: row missing`);
        continue;
      }
      if (!value.test(row[1]!)) bad.push(`${key}: value ${row[1]}`);
      if (row[2] !== ttl) bad.push(`${key}: TTL ${row[2]} != ${ttl}`);
      if (!how.test(row[3]!)) bad.push(`${key}: ${how}`);
    }
    expect(bad).toEqual([]);
    expect(d).toMatch(/32 случайных байта в base64url/);
    expect(d).toMatch(/\$\{PUBLIC_BASE_URL\}\/password\/reset\/\{token\}/);
    expect(d).toMatch(/\$\{PUBLIC_BASE_URL\}\/invite\/\{token\}/);
    expect(d).toMatch(/только worker, удерживающий `tg:poller`/);
  });

  it('P9: client IP rule, Redis JSON reading rule, no-store on token responses', () => {
    const d: string = doc.info.description;
    expect(d).toMatch(/IP клиента \(P9\)[^]*ровно один прокси-хоп[^]*последний элемент\s+`X-Forwarded-For`/);
    expect(d).toMatch(/без `X-Forwarded-For`[^.]*адрес сокетного соединения/);
    expect(d).toMatch(/JSON-значения ключей \(P9\): читатель разбирает значение как JSON/);
    expect(d).toMatch(/Исключение — `pub:batch:\{publicCode\}`/);
    for (const id of ['login', 'refreshToken', 'verifyTwoFactor']) {
      const op = ops.find(({ op }) => op.operationId === id)!.op;
      const h = deref(deref(op.responses['200']).headers['Cache-Control']);
      expect(h.required, id).toBe(true);
      expect(deref(h.schema).enum, id).toEqual(['no-store']);
    }
  });

  it('P12: JWT claim types and the per-user advisory refresh lock are documented', () => {
    const at: string = doc.components.schemas.AccessToken.description;
    for (const re of [
      /`sub` — UUID пользователя/,
      /`org` — UUID организации/,
      /`roles` — непустой массив\s+`RoleCode`/,
      /`org_admin` — boolean/,
      /`exp` и `iat` — целые/,
      /`jti` — строка/,
      /`crit`, перечисляющим неизвестные параметры, — 401 UNAUTHORIZED/,
    ])
      expect(at).toMatch(re);
    const d: string = doc.info.description;
    expect(d).toMatch(
      /Refresh-токены \(P12\)[^]*pg_advisory_xact_lock\(hashtext\('refresh:' \|\| user_id\)\)/,
    );
    expect(d).toMatch(/без взаимоблокировок: каждое получает 401, никогда 409/);
  });

  it('P15–P20: SVG limits and queue, style/CSS rules, base-name filenames, exp format, error keys', () => {
    const d: string = doc.info.description;
    expect(d).toMatch(/вложенность\s+элементов не больше 64 уровней, элементов не больше 5 000/);
    expect(d).toMatch(/атрибутов не больше 100 у элемента и 20 000 всего/);
    expect(d).toMatch(/не больше 32, значение атрибута не длиннее 64 КиБ/);
    expect(d).toMatch(/`<!DOCTYPE>` и иных объявлений/);
    expect(d).toMatch(/только элементы из списка[^]*feTurbulence/);
    expect(d).toMatch(
      /по одной выполняемой\s+и не более 8 ожидающих задач на процесс[^;]*; срок задачи — 3 с/,
    );
    expect(d).toMatch(/`\{allowed, reason: "svg-too-complex"\}`/);
    expect(d).toMatch(/предел действует и пока обработчик перезапускается/);
    expect(d).toMatch(/запуск обработчика, на котором выполняется сама задача, — нет,\s+P21/);
    expect(d).toMatch(/выполняемая доводится до конца, и результат\s+отбрасывается/);
    expect(d).toMatch(/корень с префиксом, например `s:svg`, не\s+принимается/);
    expect(d).toMatch(/атрибут `style` сохраняет только свойства fill[^]*`@` и `expression\(`/);
    expect(d).toMatch(/fill, stroke, filter, mask, clip-path, marker-\* удаляются[^]*`url\(#id\)` \(P20\)/);
    expect(d).toMatch(/все сегменты пути до последнего `\/` или `\\` отбрасываются \(P17\)/);
    expect(d).toMatch(/длина проверяется после отбрасывания пути, P20/);
    expect(d).toMatch(/`minProperties: 1`, — `errors\._root: \[validation\.minProperties\]` \(P16\)/);
    expect(d).toMatch(
      /Ключи ошибок \(P19\): пустая строка[^]*`validation\.required`[^]*`validation\.minItems`/,
    );
    expect(doc.components.schemas.FileRef.properties.originalName.description).toMatch(/Базовое имя/);
    const dl: string = ops.find(({ op }) => op.operationId === 'downloadFile')!.op.description;
    expect(dl).toContain('`^[1-9]\\d{0,11}$`');
    expect(doc.components.schemas.LogoUpload.description).toMatch(/20 000 атрибутов/);
    expect(doc.components.responses.UnsupportedMediaType.description).toMatch(/svg-too-complex/);
  });

  it('P10: RATE_LIMIT_OVERRIDES is documented as deployment configuration', () => {
    const d: string = doc.info.description;
    expect(d).toMatch(/Конфигурация развёртывания \(P10\): переменная окружения `RATE_LIMIT_OVERRIDES`/);
    expect(d).toMatch(/в эксплуатации не задаётся/);
  });

  it('IdempotencyKey text states the R53 storage precision', () => {
    const d: string = doc.components.parameters.IdempotencyKey.description;
    expect(d).toMatch(/cjson\.decode/);
    expect(d).toMatch(/вложенное JSON-значение/);
    expect(d).toMatch(/не сохраняется/);
    expect(d).toMatch(/createWaybill[^.]*второй черновик/);
  });

  it('NotificationType equals contracts/rules/notifications.json types; forced channels are recall types', () => {
    const rules = JSON.parse(readFileSync(new URL('../rules/notifications.json', import.meta.url), 'utf8'));
    expect(Object.keys(rules.types)).toEqual(doc.components.schemas.NotificationType.enum);
    expect(rules.forcedChannels).toEqual(['RECALL', 'RECALL_TASK', 'OVERDUE']);
    const groups = Object.keys(rules.recipientGroups);
    const bad: string[] = [];
    for (const [type, t] of Object.entries<Json>(rules.types)) {
      for (const g of [...t.recipients, ...(t.recipientsOnClose ?? [])])
        if (!groups.includes(g)) bad.push(`${type}: unknown recipient group ${g}`);
      if (t.payload.includes('eventId')) bad.push(`${type}: eventId is implicit`);
    }
    expect(bad).toEqual([]);
  });

  it('every operation with a `sort` parameter declares x-sort {fields, default} and paginates', () => {
    const bad: string[] = [];
    for (const { id, op } of ops) {
      const names = (op.parameters ?? []).map((p: Json) => deref(p).name);
      if (!names.includes('sort')) {
        if ('x-sort' in op) bad.push(`${id}: x-sort without sort`);
        continue;
      }
      const xs = op['x-sort'];
      if (!xs || !Array.isArray(xs.fields) || xs.fields.length === 0) {
        bad.push(`${id}: x-sort.fields`);
        continue;
      }
      const m = /^([a-zA-Z]+),(asc|desc)$/.exec(xs.default ?? '');
      if (!m || !xs.fields.includes(m[1])) bad.push(`${id}: x-sort.default`);
      if (!names.includes('page') || !names.includes('size')) bad.push(`${id}: page/size`);
      const media = deref(op.responses?.['200'] ?? {}).content?.['application/json'];
      const schema = deref(media?.schema ?? {});
      if (JSON.stringify(schema.required?.slice().sort()) !== '["items","page","size","total"]')
        bad.push(`${id}: Page envelope`);
    }
    expect(bad).toEqual([]);
  });

  it('production schemas are closed: every nested object has additionalProperties: false', () => {
    const open: string[] = [];
    const seen = new Set<Json>();
    (function walkAll() {
      for (const name of CLOSED_SCHEMAS) {
        expect(doc.components.schemas[name], name).toBeTruthy();
        (function walk(schema: Json, path: string) {
          const s = deref(schema);
          if (seen.has(s)) return;
          seen.add(s);
          const isObject =
            s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')) || s.properties;
          if (isObject && s.additionalProperties !== false && !OPEN_BY_DESIGN.includes(path)) open.push(path);
          for (const [prop, sub] of Object.entries<Json>(s.properties ?? {})) walk(sub, `${path}.${prop}`);
          if (s.items) walk(s.items, `${path}[]`);
          for (const k of ['oneOf', 'anyOf', 'allOf']) (s[k] ?? []).forEach((x: Json) => walk(x, path));
        })(doc.components.schemas[name], name);
      }
    })();
    expect(open).toEqual([]);
  });

  it('organization directory (R46) exposes only OrganizationRef + region', () => {
    const item = doc.components.schemas.OrganizationDirectoryItem;
    expect(Object.keys(item.properties).sort()).toEqual(['id', 'logoUrl', 'name', 'region', 'type']);
    expect(item.required.slice().sort()).toEqual(['id', 'logoUrl', 'name', 'region', 'type']);
    const op = ops.find(({ op }) => op.operationId === 'listOrganizations')!.op;
    const names = (op.parameters ?? []).map((p: Json) => deref(p).name);
    expect(names.sort()).toEqual(['page', 'q', 'size', 'sort', 'type']);
    expect(op['x-sort']).toEqual({ fields: ['name'], default: 'name,asc' });
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
    ajv.addVocabulary(['example', 'discriminator', 'xml', 'externalDocs']);
    ajv.addVocabulary(['openapi', 'info', 'servers', 'security', 'tags', 'paths', 'components']);
    ajv.addSchema(doc, 'urn:agrotrace:openapi');

    (function walk(node: unknown, ptr: string[]) {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, [...ptr, String(i)]));
      if (!node || typeof node !== 'object') return;
      const obj = node as Json;
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

  it('production value schemas reject invalid values and accept boundary values', () => {
    const ring = [
      [39.0, 45.0],
      [39.1, 45.0],
      [39.0, 45.0],
    ];
    const cases: [string, unknown, boolean][] = [
      ['PositiveMass', '0.001', true],
      ['PositiveMass', '999999999.999', true],
      ['PositiveMass', '0.000', false],
      ['PositiveMass', '000.000', false],
      ['PositiveMass', '1.5', false],
      ['AreaHa', '0.01', true],
      ['AreaHa', '0.00', false],
      ['AreaHa', '12.5', false],
      ['Dose', '0.000', false],
      ['Dose', '0.250', true],
      ['GeoJsonPolygon', { type: 'Polygon', coordinates: [ring] }, false],
      ['GeoJsonPolygon', { type: 'Polygon', coordinates: [[...ring, [39.0, 45.0]]] }, true],
      [
        'GeoJsonPolygon',
        {
          type: 'Polygon',
          coordinates: [
            [
              [200, 45],
              [39, 45],
              [39, 46],
              [200, 45],
            ],
          ],
        },
        false,
      ],
      ['NullableGeoJsonPolygon', null, true],
      ['WaybillReject', { reason: '   ' }, false],
      ['BatchCreate', { fieldId: 'x', productId: 'y', massKg: '1.000', harvestedAt: 'z' }, false],
      ['ProcessingRequest', { inputs: [], outputs: [] }, false],
      ['DiscrepancyPercent', '100000.00', true],
      ['LossNormPercent', '100.00', true],
      ['LossNormPercent', '0.00', true],
      ['LossNormPercent', '100.01', false],
      ['LossNormPercent', '5.5', false],
      ['IndicatorValue', '0.015000', true],
      ['IndicatorValue', '0.015', false],
      ['Hours', '18.25', true],
      ['Hours', '18.2', false],
      ['LabResultsInput', { results: [] }, false],
      [
        'LabResultsInput',
        { results: [{ indicatorId: '2b4d6f8a-0c2e-4a4b-8d6f-8a0c2e4b6d8f', value: '1e3' }] },
        false,
      ],
      ['ComplaintDecision', { decision: 'LAB_TEST', comment: 'Проверить' }, false],
      [
        'ComplaintDecision',
        { decision: 'REJECT', comment: 'Нет', labOrgId: '5a7c9e1b-3d5f-4a7c-9e1b-3d5f7a9c1e3b' },
        false,
      ],
      ['ComplaintDecision', { decision: 'REJECT', comment: 'Нет', blockUpstream: true }, false],
      ['ComplaintDecision', { decision: 'RECALL', comment: 'Отзыв', blockUpstream: true }, true],
      ['ComplaintDecision', { decision: 'RECALL', comment: '   ' }, false],
      ['MarkReadRequest', { ids: ['b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e'], upToSeq: 3 }, false],
      ['MarkReadRequest', { upToSeq: 1042 }, true],
      ['MarkReadRequest', { ids: [] }, false],
      ['OrganizationAdminPatch', {}, false],
      ['OrganizationAdminPatch', { status: 'PENDING' }, false],
      ['RecallCreate', { sourceBatchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c', reason: 'x' }, false],
      ['NormInput', { productId: 'x', indicatorId: 'y', maxValue: '-1' }, false],
      ['RegionInput', { code: 'кр', name: 'Край' }, false],
    ];
    const bad: string[] = [];
    for (const [name, value, valid] of cases) {
      const validate = ajv.compile({ $ref: toRef(['components', 'schemas', name]) });
      if (validate(value) !== valid) bad.push(`${name} ${JSON.stringify(value)} expected ${valid}`);
    }
    expect(bad).toEqual([]);
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
