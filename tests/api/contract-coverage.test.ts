/**
 * Contract coverage (Task 14): every operation of the contract was called by some test of this run and its response
 * checked by expectContract, and every declared response code of every operation was seen at least once — except the
 * codes in EXCLUDED below, each with its reason (no scenario on the test stand). Records come from the harness
 * registry (lib/registry.ts) of the whole run; lib/sequencer.ts runs this file last.
 *
 * Enforced only on a full run (every top-level `*.test.ts` of tests/api, no `-t` name filter): a single-file run
 * (`./at api:test express auth`) or the `--ratelimits` pass skips it. With API_COVERAGE_REQUIRED=1 (set by
 * `./at api:test <backend>` when it passes no vitest arguments) a run that is not full FAILS instead of skipping, so
 * the gate cannot silently disappear (a missing `run` record, a changed sequencer).
 *
 * Granularity (review M1): coverage is per (operation, status). The generated permission matrix alone yields 401,
 * the role 403, a `_root` 400 and a random-id 404 for almost every operation, so this gate does not show that an
 * operation-specific variant of a status (403 NOT_HOLDER, a field-level 400, …) has a test of its own; those stay
 * the business suites' responsibility.
 */
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contract, type Operation } from './lib/contract.js';
import { readRecords, type RegistryRecord } from './lib/registry.js';

interface Excluded {
  /** operationIds, or '*' for every operation that declares `code`. */
  ops: readonly string[] | '*';
  code: string;
  reason: string;
  /** Mechanical justification: null when the exclusion fits the operation, else why not (a stale entry). */
  check?: (op: Operation) => string | null;
}

const ROLE_ANY_FORBIDDEN = '#/components/responses/Forbidden';

/**
 * Declared codes without a scenario. An entry whose code is covered after all, names an operation that does not
 * declare the code, or fails its `check`, fails the test — stale entries are not allowed to hide future gaps.
 */
export const EXCLUDED: readonly Excluded[] = [
  {
    ops: '*',
    code: '429',
    reason:
      'P10: the default run uses RATE_LIMIT_OVERRIDES, so no limit is reached; the [ratelimit] tests ' +
      '(`./at api:test <backend> --ratelimits`, a separate CI step) cover the limits',
  },
  {
    // x-roles ANY: every authenticated role is allowed, and the operation defines no 403 of its own (the response is
    // the shared «Недостаточно прав» without reasons), so no request can produce it.
    ops: [
      'getMe',
      'updateMe',
      'uploadMyAvatar',
      'deleteMyAvatar',
      'getMyChannels',
      'updateMyChannels',
      'createTelegramCode',
      'getUserAvatar',
      'listOrganizations',
      'getOrganization',
      'getOrganizationLogo',
      'listBatches',
      'getBatch',
      'getBatchGraph',
      'getBatchHistory',
      'getBatchPath',
      'getBatchDocuments',
      'listLabTests',
      'getLabTest',
      'downloadLabProtocol',
      'listNotifications',
      'markNotificationsRead',
      'getDashboard',
      'listDictionary',
      'streamEvents',
    ],
    code: '403',
    reason:
      'x-roles ANY with the shared Forbidden response: no role is outside x-roles and no operation-specific 403',
    check: (op) =>
      !(op.op['x-roles'] as string[]).includes('ANY')
        ? 'x-roles is not ANY'
        : op.op.responses['403']?.$ref !== ROLE_ANY_FORBIDDEN
          ? 'the 403 is operation-specific'
          : /403|FORBIDDEN/.test(`${op.op.summary ?? ''} ${op.op.description ?? ''}`)
            ? 'its description names a 403 scenario (review M4)'
            : null,
  },
  {
    ops: ['createBatchQr', 'processBatches', 'uploadLabProtocol', 'createRecall'],
    code: '409',
    reason:
      'R47: VERSION_CONFLICT after a repeated deadlock/serialization failure (one retry first); processBatches also ' +
      'GRAPH_CYCLE, a defensive check the API cannot reach (inputs must be own unprocessed batches); no ' +
      'deterministic HTTP scenario',
  },
  {
    ops: ['getHealthReady'],
    code: '503',
    reason: 'a dependency (DB, Redis, RabbitMQ, MinIO) must be down; the suite runs against a healthy stand',
  },
  {
    ops: ['createTelegramCode'],
    code: '503',
    reason:
      'answered only without TELEGRAM_BOT_TOKEN; the api-test profile sets a token (docker-compose.api-test.yml)',
  },
  {
    ops: ['downloadReport'],
    code: '503',
    reason:
      'P52 report-busy: the render queue (1 running + 4 waiting per process) must overflow or a render exceed ' +
      '120 s; not reproducible deterministically over HTTP (backend unit test)',
  },
];

const HERE = dirname(fileURLToPath(import.meta.url));
const ALL_FILES = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

const records = readRecords();
const run = records.find((r): r is Extract<RegistryRecord, { kind: 'run' }> => r.kind === 'run');
const missingFiles = ALL_FILES.filter((f) => !run?.files.includes(f));
const required = process.env.API_COVERAGE_REQUIRED === '1';
const full = run !== undefined && run.testNamePattern === null && missingFiles.length === 0;
const why = !run
  ? 'no run record (sequencer not used)'
  : run.testNamePattern !== null
    ? `name filter ${run.testNamePattern}`
    : `files not in this run: ${missingFiles.join(', ')}`;

const excludedFor = (op: string, code: string) =>
  EXCLUDED.find((e) => (e.ops === '*' || e.ops.includes(op)) && e.code === code);

describe('contract coverage', () => {
  (full || required ? it : it.skip)(
    full || required
      ? 'every operation and every declared response code is covered (or excluded with a reason)'
      : `not a full run (${why})`,
    async () => {
      expect(full, `API_COVERAGE_REQUIRED=1 but ${why}`).toBe(true);
      const c = await contract();
      const seen = new Map<string, Set<string>>();
      for (const r of records)
        if (r.kind === 'checked') {
          if (!seen.has(r.operationId)) seen.set(r.operationId, new Set());
          seen.get(r.operationId)!.add(String(r.status));
        }

      const uncoveredOps: string[] = [];
      const codeGaps: string[] = [];
      const stale: string[] = [];
      let declaredCodes = 0;
      let coveredCodes = 0;
      let excludedCodes = 0;
      for (const [id, op] of c.ops) {
        const statuses = seen.get(id);
        if (!statuses) uncoveredOps.push(`${id} (${op.method} ${op.path})`);
        for (const code of Object.keys(op.op.responses)) {
          declaredCodes++;
          const hit = statuses?.has(code) ?? false;
          const ex = excludedFor(id, code);
          if (hit) coveredCodes++;
          if (hit && ex && ex.ops !== '*') stale.push(`${id} ${code} is excluded but covered`);
          if (!hit && ex) excludedCodes++;
          if (!hit && !ex) codeGaps.push(`${id} ${code}`);
        }
      }
      for (const e of EXCLUDED) {
        if (e.ops === '*') continue;
        for (const id of e.ops) {
          const op = c.ops.get(id);
          if (!op || !(e.code in op.op.responses)) stale.push(`${id} ${e.code} is excluded but not declared`);
          else {
            const bad = e.check?.(op);
            if (bad) stale.push(`${id} ${e.code} is excluded, but ${bad}`);
          }
        }
      }

      const total = c.ops.size;
      console.log(
        [
          `contract coverage: operations ${total - uncoveredOps.length}/${total}; ` +
            `response codes ${coveredCodes}/${declaredCodes} covered, ${excludedCodes} excluded, ` +
            `${codeGaps.length} gaps`,
          ...uncoveredOps.map((s) => `  uncovered operation: ${s}`),
          ...codeGaps.map((s) => `  uncovered code: ${s}`),
          ...stale.map((s) => `  stale exclusion: ${s}`),
        ].join('\n'),
      );
      expect(uncoveredOps, 'operations no test called (with expectContract)').toEqual([]);
      expect(codeGaps, 'declared response codes no test saw').toEqual([]);
      expect(stale, 'stale EXCLUDED entries').toEqual([]);
    },
  );
});
