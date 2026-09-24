import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import * as V from '../src/index.js';
import { isValidInn, massKg, inn as innSchema } from '../src/common.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped OpenAPI JSON, mirrors contracts/test
type Json = Record<string, any>;

const ROOT = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../../contracts/redocly.yaml', import.meta.url));

const URN = 'urn:agrotrace:validation-test:openapi';

// Every `requestBody` schema `$ref` used by any operation in the contract,
// discovered dynamically (not hardcoded) so this test fails the moment the
// contract adds/renames a request body without a matching Zod schema.
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

// Top-level await: the contract must be bundled before `describe` blocks
// below (several of which enumerate schemas at collection time) run.
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

/** Validates `value` against `components.schemas[name]` in the bundled contract. */
function validateAgainstContract(name: string, value: unknown) {
  const validate = ajv.compile({ $ref: `${URN}#/components/schemas/${name}` });
  const ok = validate(value);
  return { ok, errors: ok ? [] : ajv.errorsText(validate.errors) };
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

/** Multipart file uploads carry no JSON `example` in the contract. */
const FILE_UPLOAD_SCHEMAS = new Set(['ImageUpload', 'LogoUpload', 'ImportUpload', 'ProtocolUpload']);

// `DictionaryInput` (a bare `anyOf` over 5 named schemas) has no example of its
// own either — its arms are covered individually by the dedicated describe block below.
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

describe('generic invalid-input coverage for every schema (unknown key + missing required field)', () => {
  for (const name of REQUEST_BODY_SCHEMAS) {
    if (NO_JSON_EXAMPLE.has(name)) continue;
    const contractSchema = doc.components.schemas[name] as Json;
    const example = contractSchema.example;
    if (example === undefined || typeof example !== 'object' || Array.isArray(example)) continue;

    describe(name, () => {
      it('rejects an unknown property (additionalProperties: false)', () => {
        const schema = (V as unknown as Record<string, z.ZodTypeAny>)[`${name}Schema`];
        const withBogusKey = { ...example, __bogus__: 'x' };
        expect(schema.safeParse(withBogusKey).success).toBe(false);
      });

      const required: string[] = Array.isArray(contractSchema.required) ? contractSchema.required : [];
      if (required.length > 0) {
        it(`rejects a missing required field ('${required[0]}')`, () => {
          const schema = (V as unknown as Record<string, z.ZodTypeAny>)[`${name}Schema`];
          const clone: Json = { ...example };
          delete clone[required[0]!];
          expect(schema.safeParse(clone).success).toBe(false);
        });
      }
    });
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

describe('toFieldErrors', () => {
  it('flattens a nested array path (items.0.massDeclaredKg)', () => {
    const result = V.WaybillCreateSchema.safeParse({
      receiverOrgId: '4b6d8f0a-2c4e-4a6b-8d0f-1a3c5e7a9b1d',
      items: [{ batchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c', massDeclaredKg: 'not-a-mass' }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const errors = V.toFieldErrors(result.error);
    expect(errors['items.0.massDeclaredKg']).toContain('validation.mass.format');
  });

  it('produces one entry per invalid field, each a non-empty list of i18n keys', () => {
    const result = V.LoginRequestSchema.safeParse({ email: 'not-an-email' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const errors = V.toFieldErrors(result.error);
    expect(errors['email']).toEqual(['validation.email']);
    expect(errors['password']).toBeDefined();
    expect(errors['password']!.length).toBeGreaterThan(0);
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
});
