import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import * as V from '../src/index.js';
import { isValidInn, massKg, inn as innSchema } from '../src/common.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const ROOT = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../../contracts/redocly.yaml', import.meta.url));

const URN = 'urn:agrotrace:validation-test:openapi';

function collectRequestBodySchemaNames(spec: Json): string[] {
  const names = new Set<string>();
  for (const methods of Object.values<Json>(spec.paths)) {
    for (const op of Object.values<Json>(methods)) {
      if (!op || typeof op !== 'object' || !op.requestBody?.content) continue;
      for (const media of Object.values<Json>(op.requestBody.content)) {
        const ref = media.schema?.$ref;
        if (ref) names.add(String(ref).split('/').pop());
      }
    }
  }
  return [...names].sort();
}

const config = await loadConfig({ configPath: CONFIG });
const bundleResult = await bundle({ ref: ROOT, config });
const doc = bundleResult.bundle.parsed as Json;

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
ajv.addSchema(doc, URN);

function validateAgainstContract(name: string, value: unknown) {
  const validate = ajv.compile({ $ref: `${URN}#/components/schemas/${name}` });
  const ok = validate(value);
  return { ok, errors: ok ? [] : ajv.errorsText(validate.errors) };
}

function flattenKeys(node: unknown, prefix: string, out: string[]): string[] {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flattenKeys(value, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.push(prefix);
  }
  return out;
}
const I18N_LOCALES_DIR = fileURLToPath(new URL('../../i18n/locales', import.meta.url));
const RU_DICT = JSON.parse(readFileSync(`${I18N_LOCALES_DIR}/ru.json`, 'utf8'));
const EN_DICT = JSON.parse(readFileSync(`${I18N_LOCALES_DIR}/en.json`, 'utf8'));
const RU_I18N_KEYS = new Set(flattenKeys(RU_DICT, '', []));
const EN_I18N_KEYS = new Set(flattenKeys(EN_DICT, '', []));

function deref(node: Json | undefined): Json | undefined {
  if (!node) return node;
  if (node.$ref) return doc.components.schemas[String(node.$ref).split('/').pop()!];
  return node;
}

function mismatchedTypeValue(value: unknown): unknown {
  if (typeof value === 'string') return 12345;
  if (typeof value === 'number') return 'not-a-number';
  if (typeof value === 'boolean') return 'not-a-boolean';
  if (Array.isArray(value)) return 'not-an-array';
  if (value !== null && typeof value === 'object') return 'not-an-object';
  return undefined;
}

function expectOnlyTranslatedValidationKeys(error: z.ZodError) {
  const messages = Object.values(V.toFieldErrors(error)).flat();
  for (const message of messages) {
    expect(message).toMatch(/^validation\./);
    expect(RU_I18N_KEYS.has(message), `ru: missing translation for '${message}'`).toBe(true);
    expect(EN_I18N_KEYS.has(message), `en: missing translation for '${message}'`).toBe(true);
  }
}

function runNoEnglishLeaksBattery(name: string, schema: z.ZodTypeAny, contractSchema: Json, example: Json) {
  describe(name, () => {
    it('empty object', () => {
      const result = schema.safeParse({});
      if (result.success) return;
      expectOnlyTranslatedValidationKeys(result.error);
    });

    const required: string[] = Array.isArray(contractSchema.required) ? contractSchema.required : [];
    for (const key of required) {
      it(`missing required field '${key}'`, () => {
        const clone: Json = { ...example };
        delete clone[key];
        const result = schema.safeParse(clone);
        expect(result.success).toBe(false);
        if (result.success) return;
        expectOnlyTranslatedValidationKeys(result.error);
      });
    }

    for (const key of Object.keys(example)) {
      const propSchema = deref(contractSchema.properties?.[key]);
      const value = example[key];

      const mismatch = mismatchedTypeValue(value);
      if (mismatch !== undefined) {
        it(`wrong type for '${key}'`, () => {
          const result = schema.safeParse({ ...example, [key]: mismatch });
          expect(result.success).toBe(false);
          if (result.success) return;
          expectOnlyTranslatedValidationKeys(result.error);
        });
      }

      if (Array.isArray(propSchema?.enum)) {
        it(`bogus enum value for '${key}'`, () => {
          const result = schema.safeParse({ ...example, [key]: '__NOT_A_VALID_ENUM_VALUE__' });
          expect(result.success).toBe(false);
          if (result.success) return;
          expectOnlyTranslatedValidationKeys(result.error);
        });
      }

      if (
        typeof value === 'string' &&
        typeof propSchema?.minLength === 'number' &&
        propSchema.minLength > 0
      ) {
        it(`too-short string for '${key}' (minLength ${propSchema.minLength})`, () => {
          const tooShort = 'a'.repeat(Math.max(0, propSchema.minLength - 1));
          const result = schema.safeParse({ ...example, [key]: tooShort });
          expect(result.success).toBe(false);
          if (result.success) return;
          expectOnlyTranslatedValidationKeys(result.error);
        });
      }

      if (typeof value === 'string' && typeof propSchema?.maxLength === 'number') {
        it(`too-long string for '${key}' (maxLength ${propSchema.maxLength})`, () => {
          const tooLong = 'a'.repeat(propSchema.maxLength + 1);
          const result = schema.safeParse({ ...example, [key]: tooLong });
          expect(result.success).toBe(false);
          if (result.success) return;
          expectOnlyTranslatedValidationKeys(result.error);
        });
      }
    }

    it('unknown key', () => {
      const result = schema.safeParse({ ...example, __bogus_unknown_field__: 'x' });
      expect(result.success).toBe(false);
      if (result.success) return;
      expectOnlyTranslatedValidationKeys(result.error);
      const errors = V.toFieldErrors(result.error);
      expect(errors['__bogus_unknown_field__']).toEqual(['validation.unknownField']);
    });
  });
}

const REQUEST_BODY_SCHEMAS = [
  'AcceptInviteRequest',
  'BatchCreate',
  'ChannelsUpdate',
  'ComplaintDecision',
  'ComplaintReviewRequest',
  'DictionaryInput',
  'FieldInput',
  'ForgotPasswordRequest',
  'ImageUpload',
  'ImportUpload',
  'LabResultsInput',
  'LabSampleRequest',
  'LabTestCreate',
  'LoginRequest',
  'LogoUpload',
  'MarkReadRequest',
  'MeUpdate',
  'OrganizationAdminPatch',
  'ProcessingRequest',
  'ProtocolUpload',
  'PublicComplaintRequest',
  'QrRequest',
  'RecallCreate',
  'RecallTaskConfirm',
  'RegisterOrganizationRequest',
  'ResetPasswordRequest',
  'TreatmentInput',
  'TwoFactorSetupRequest',
  'TwoFactorVerifyRequest',
  'UserInvite',
  'UserPatch',
  'WaybillAccept',
  'WaybillCreate',
  'WaybillReject',
] as const;

const FILE_UPLOAD_SCHEMAS = new Set(['ImageUpload', 'LogoUpload', 'ImportUpload', 'ProtocolUpload']);

const NO_JSON_EXAMPLE = new Set([...FILE_UPLOAD_SCHEMAS, 'DictionaryInput']);

describe('the contract has exactly the request bodies this test expects (fixture freshness)', () => {
  it('matches the dynamically-collected list from openapi.yaml', () => {
    expect(collectRequestBodySchemaNames(doc)).toEqual([...REQUEST_BODY_SCHEMAS]);
  });
});

describe('every request body schema in the contract has a Zod counterpart', () => {
  it('exports `<Name>Schema` for every contract request body — no gaps', () => {
    const names = collectRequestBodySchemaNames(doc);
    const missing = names.filter((name) => {
      const exported = (V as unknown as Record<string, unknown>)[`${name}Schema`];
      return !exported || typeof (exported as z.ZodTypeAny).safeParse !== 'function';
    });
    expect(missing).toEqual([]);
  });
});

describe('every schema with a JSON example: the example parses, and the parsed output validates against the contract', () => {
  for (const name of REQUEST_BODY_SCHEMAS) {
    if (NO_JSON_EXAMPLE.has(name)) continue;
    it(`${name}`, () => {
      const example = doc.components.schemas[name]?.example;
      expect(example, `${name} has no example in the contract`).toBeDefined();
      const schema = (V as unknown as Record<string, z.ZodTypeAny>)[`${name}Schema`];
      const parsed = schema.parse(example);
      const { ok, errors } = validateAgainstContract(name, parsed);
      expect(ok, errors).toBe(true);
    });
  }
});

describe('every schema only ever produces translated validation.* keys (no Zod English leaks)', () => {
  for (const name of REQUEST_BODY_SCHEMAS) {
    if (NO_JSON_EXAMPLE.has(name)) continue;
    const contractSchema = doc.components.schemas[name] as Json;
    const example = contractSchema.example;
    if (example === undefined || typeof example !== 'object' || Array.isArray(example)) continue;
    const schema = (V as unknown as Record<string, z.ZodTypeAny>)[`${name}Schema`];
    runNoEnglishLeaksBattery(name, schema, contractSchema, example);
  }

  const DICTIONARY_ARMS = [
    'ProductInput',
    'SubstanceInput',
    'IndicatorInput',
    'NormInput',
    'RegionInput',
  ] as const;
  for (const arm of DICTIONARY_ARMS) {
    const contractSchema = doc.components.schemas[arm] as Json;
    const schema = (V as unknown as Record<string, z.ZodTypeAny>)[`${arm}Schema`];
    runNoEnglishLeaksBattery(arm, schema, contractSchema, contractSchema.example);
  }
});

describe('file uploads (no JSON example, metadata-only Zod schema)', () => {
  for (const name of FILE_UPLOAD_SCHEMAS) {
    it(`${name}Schema requires 'file' and rejects unknown keys`, () => {
      const schema = (V as unknown as Record<string, z.ZodTypeAny>)[`${name}Schema`];
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ file: 'x', extra: 1 }).success).toBe(false);
    });
  }
});

describe('massKg (common primitive)', () => {
  it('"12" -> "12.000"', () => {
    expect(massKg.parse('12')).toBe('12.000');
  });
  it('"12480.000" stays "12480.000"', () => {
    expect(massKg.parse('12480.000')).toBe('12480.000');
  });
  it('"0" is rejected (not positive)', () => {
    expect(massKg.safeParse('0').success).toBe(false);
  });
  it('"1.2345" is rejected (more than 3 decimals)', () => {
    expect(massKg.safeParse('1.2345').success).toBe(false);
  });
  it('"-1" is rejected (not a valid shape)', () => {
    expect(massKg.safeParse('-1').success).toBe(false);
  });
});

describe('inn (common primitive, FNS checksum)', () => {
  it('isValidInn: 7707083893 is a valid 10-digit INN', () => {
    expect(isValidInn('7707083893')).toBe(true);
  });
  it('isValidInn: 7707083894 fails the checksum', () => {
    expect(isValidInn('7707083894')).toBe(false);
  });
  it('the `inn` schema accepts a checksum-valid INN', () => {
    expect(innSchema.safeParse('7707083893').success).toBe(true);
  });
  it('the `inn` schema rejects a checksum-invalid INN', () => {
    expect(innSchema.safeParse('7707083894').success).toBe(false);
  });
  it('the `inn` schema rejects the wrong number of digits', () => {
    expect(innSchema.safeParse('123').success).toBe(false);
  });
});

describe('RegisterOrganizationRequestSchema enforces the INN checksum (R66)', () => {
  const base = {
    type: 'FARM',
    regionCode: '23',
    admin: { email: 'a@b.ru', fullName: 'А Б', password: 'Urozhai-2026!' },
  };

  it('accepts the (checksum-valid) contract example', () => {
    const example = doc.components.schemas.RegisterOrganizationRequest.example;
    expect(V.RegisterOrganizationRequestSchema.safeParse(example).success).toBe(true);
  });

  it('rejects a checksum-invalid INN with validation.inn.checksum', () => {
    const result = V.RegisterOrganizationRequestSchema.safeParse({ ...base, inn: '2311123456' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error)).toEqual({ inn: ['validation.inn.checksum'] });
  });

  it('accepts a checksum-valid INN', () => {
    expect(V.RegisterOrganizationRequestSchema.safeParse({ ...base, inn: '2311123457' }).success).toBe(true);
  });
});

describe('toFieldErrors', () => {
  it('flattens a nested array path to the contract form items[0].massDeclaredKg (info.description)', () => {
    const result = V.WaybillCreateSchema.safeParse({
      receiverOrgId: '4b6d8f0a-2c4e-4a6b-8d0f-1a3c5e7a9b1d',
      items: [{ batchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c', massDeclaredKg: 'not-a-mass' }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error)).toEqual({
      'items[0].massDeclaredKg': ['validation.mass.format'],
    });
  });

  it('produces an exact error object, one entry per invalid field', () => {
    const result = V.LoginRequestSchema.safeParse({ email: 'not-an-email' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error)).toEqual({
      email: ['validation.email'],
      password: ['validation.required'],
    });
  });

  it("expands unrecognized_keys into one entry per offending key, at that key's own path", () => {
    const result = V.LoginRequestSchema.safeParse({
      email: 'a@b.ru',
      password: 'Urozhai-2026!',
      foo: 1,
      bar: 2,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error)).toEqual({
      foo: ['validation.unknownField'],
      bar: ['validation.unknownField'],
    });
  });

  it('never leaks a Zod English default for a wrong-typed field', () => {
    const result = V.ChannelsUpdateSchema.safeParse({ email: 'yes', telegram: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error)).toEqual({
      email: ['validation.type'],
      telegram: ['validation.type'],
    });
  });

  it('never leaks a Zod English default for a bogus enum value', () => {
    const result = V.UserPatchSchema.safeParse({ status: 'DELETED' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error)).toEqual({ status: ['validation.enum'] });
  });

  it('never leaks a Zod English default for a missing required boolean/array', () => {
    const result = V.RecallCreateSchema.safeParse({ sourceBatchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error)).toEqual({
      reason: ['validation.required'],
      blockUpstream: ['validation.required'],
    });
  });
});

describe('codePointString distinguishes empty (required) from too-short (minLength) — Important 2', () => {
  it('an empty complaint text is validation.required (not validation.minLength)', () => {
    const result = V.PublicComplaintRequestSchema.safeParse({ text: '', altcha: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = V.toFieldErrors(result.error).text ?? [];
    expect(messages).toContain('validation.required');
    expect(messages).not.toContain('validation.minLength');
  });

  it('a present, non-empty, but too-short complaint text is validation.minLength', () => {
    const result = V.PublicComplaintRequestSchema.safeParse({ text: 'short', altcha: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error).text).toEqual(['validation.minLength']);
  });

  it('an empty password is validation.required (via its own dedicated min(1) check)', () => {
    const result = V.ResetPasswordRequestSchema.safeParse({ token: 'a'.repeat(20), password: '' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error).password).toContain('validation.required');
  });

  it('9 chars is one below the 10-char minimum: still validation.minLength, not validation.required', () => {
    const result = V.PublicComplaintRequestSchema.safeParse({ text: 'x'.repeat(9), altcha: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error).text).toEqual(['validation.minLength']);
  });
});

describe('minProperties: 1 rejects {} — Important 4', () => {
  it('OrganizationAdminPatchSchema', () => {
    expect(V.OrganizationAdminPatchSchema.safeParse({}).success).toBe(false);
  });
  it('MeUpdateSchema', () => {
    expect(V.MeUpdateSchema.safeParse({}).success).toBe(false);
  });
  it('UserPatchSchema', () => {
    expect(V.UserPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe('ComplaintDecision (discriminated union)', () => {
  it('REJECT requires only decision + comment', () => {
    expect(
      V.ComplaintDecisionSchema.safeParse({ decision: 'REJECT', comment: 'Недостаточно данных' }).success,
    ).toBe(true);
  });
  it('LAB_TEST without labOrgId is rejected', () => {
    expect(V.ComplaintDecisionSchema.safeParse({ decision: 'LAB_TEST', comment: 'x' }).success).toBe(false);
  });
  it('RECALL defaults blockUpstream to false', () => {
    const parsed = V.ComplaintDecisionSchema.parse({ decision: 'RECALL', comment: 'Нарушение выявлено' });
    expect(parsed).toMatchObject({ blockUpstream: false });
  });
  it('an unknown decision value is rejected', () => {
    expect(V.ComplaintDecisionSchema.safeParse({ decision: 'APPROVE', comment: 'x' }).success).toBe(false);
  });
});

describe('MarkReadRequest (oneOf without a discriminant)', () => {
  it('accepts { upToSeq }', () => {
    expect(V.MarkReadRequestSchema.safeParse({ upToSeq: 42 }).success).toBe(true);
  });
  it('rejects both ids and upToSeq together (strict arms)', () => {
    expect(
      V.MarkReadRequestSchema.safeParse({
        ids: ['b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e'],
        upToSeq: 1,
      }).success,
    ).toBe(false);
  });
  it('rejects duplicate ids', () => {
    const dup = 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e';
    expect(V.MarkReadRequestSchema.safeParse({ ids: [dup, dup] }).success).toBe(false);
  });
});

describe('DictionaryInput (anyOf over the 5 dictionary item schemas)', () => {
  const arms = ['ProductInput', 'SubstanceInput', 'IndicatorInput', 'NormInput', 'RegionInput'] as const;
  for (const arm of arms) {
    it(`accepts the contract's ${arm} example and it validates against DictionaryInput`, () => {
      const example = doc.components.schemas[arm].example;
      const parsed = V.DictionaryInputSchema.parse(example);
      const { ok, errors } = validateAgainstContract('DictionaryInput', parsed);
      expect(ok, errors).toBe(true);
    });
  }
});

describe('duplicate detection inside array bodies', () => {
  it('ProcessingRequest rejects a duplicate batchId across inputs', () => {
    const dup = '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c';
    const product = 'a4c6e8f0-2b4d-4f6a-8c0e-4b6d8f0a2c4e';
    const result = V.ProcessingRequestSchema.safeParse({
      inputs: [
        { batchId: dup, massUsedKg: '10.000' },
        { batchId: dup, massUsedKg: '5.000' },
      ],
      outputs: [{ productId: product, massKg: '7.000' }],
    });
    expect(result.success).toBe(false);
  });

  it('LabResultsInput rejects a duplicate indicatorId', () => {
    const dup = '2b4d6f8a-0c2e-4a4b-8d6f-8a0c2e4b6d8f';
    const result = V.LabResultsInputSchema.safeParse({
      results: [
        { indicatorId: dup, value: '1' },
        { indicatorId: dup, value: '2' },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('duplicate items are keyed at the repeated element field (contract, I4)', () => {
  const a = '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c';
  const b = '4b6d8f0a-2c4e-4a6b-8d0f-1a3c5e7a9b1d';
  const product = 'a4c6e8f0-2b4d-4f6a-8c0e-4b6d8f0a2c4e';

  it('processing: errors["inputs[i].batchId"] for every repeat (processing.yaml step 1)', () => {
    const r = V.ProcessingRequestSchema.safeParse({
      inputs: [
        { batchId: a, massUsedKg: '10.000' },
        { batchId: b, massUsedKg: '1.000' },
        { batchId: a, massUsedKg: '5.000' },
        { batchId: a, massUsedKg: '2.000' },
      ],
      outputs: [{ productId: product, massKg: '7.000' }],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(V.toFieldErrors(r.error)).toEqual({
      'inputs[2].batchId': ['validation.duplicate'],
      'inputs[3].batchId': ['validation.duplicate'],
    });
  });

  it('lab results: errors["results[i].indicatorId"] (lab.yaml submitLabResults step 5)', () => {
    const r = V.LabResultsInputSchema.safeParse({
      results: [
        { indicatorId: b, value: '1' },
        { indicatorId: b, value: '2' },
      ],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(V.toFieldErrors(r.error)).toEqual({ 'results[1].indicatorId': ['validation.duplicate'] });
  });

  it('waybill create: errors["items[i].batchId"] (waybills.yaml createWaybill step 2)', () => {
    const r = V.WaybillCreateSchema.safeParse({
      receiverOrgId: b,
      items: [
        { batchId: a, massDeclaredKg: '1.000' },
        { batchId: a, massDeclaredKg: '2.000' },
      ],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(V.toFieldErrors(r.error)).toEqual({ 'items[1].batchId': ['validation.duplicate'] });
  });
});
describe('FieldInput geometry', () => {
  it('accepts a closed ring and null geometry', () => {
    expect(
      V.FieldInputSchema.safeParse({ name: 'Поле 1', areaHa: '1.00', regionCode: '23', geometry: null })
        .success,
    ).toBe(true);
  });
  it('rejects a ring whose first and last positions differ', () => {
    const result = V.FieldInputSchema.safeParse({
      name: 'Поле 1',
      areaHa: '1.00',
      regionCode: '23',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [39.0, 45.0],
            [39.1, 45.0],
            [39.0, 45.1],
          ],
        ],
      },
    });
    expect(result.success).toBe(false);
  });
  it('an empty ring is a minItems error, not an exception', () => {
    const result = V.FieldInputSchema.safeParse({
      name: 'Поле 1',
      areaHa: '1.00',
      regionCode: '23',
      geometry: { type: 'Polygon', coordinates: [[]] },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(V.toFieldErrors(result.error)).toEqual({ 'geometry.coordinates[0]': ['validation.minItems'] });
  });
});

describe('ProductInput.mercuryCode (R81)', () => {
  const base = { name: 'Молоко сырое коровье', category: 'DAIRY', lossNormPercent: '1.00' };
  it('is optional and nullable, accepts OKPD2-style codes', () => {
    for (const mercuryCode of [undefined, null, '10.51.11', '01.47', '10.11.11.110'])
      expect(V.ProductInputSchema.safeParse({ ...base, mercuryCode }).success, String(mercuryCode)).toBe(
        true,
      );
  });
  it('rejects other shapes with validation.mercuryCode.format', () => {
    for (const mercuryCode of ['10-51-11', '1.51.11', '10.5111', '', '10.51.11 ']) {
      const r = V.ProductInputSchema.safeParse({ ...base, mercuryCode });
      expect(r.success, mercuryCode).toBe(false);
      if (!r.success) expect(V.toFieldErrors(r.error).mercuryCode).toContain('validation.mercuryCode.format');
    }
  });
});
