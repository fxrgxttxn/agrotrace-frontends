/**
 * Call registry for contract coverage (Task 14, contract-coverage.test.ts). Every request the harness sends (method,
 * path, status) and every contract-checked REAL response (operationId, status) is recorded. Responses are real when
 * they came from the backend (ApiClient, lib/sse.ts mark them); the harness meta-tests validate hand-made responses,
 * which must not count as coverage.
 *
 * Records are appended as NDJSON to CALLS_FILE so a full run aggregates every test file (each file runs in its own
 * worker). The run's sequencer (lib/sequencer.ts) truncates the file and writes a `run` record listing the files of
 * the run; contract-coverage.test.ts — always the last file — reads it and enforces coverage only on a full run.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CallRecord {
  method: string;
  path: string;
  status: number;
}
export interface CheckedRecord {
  operationId: string;
  status: number;
}
export interface RunRecord {
  /** Test files of the run, relative to tests/api (`auth.test.ts`). */
  files: string[];
  /** The run's `-t` / testNamePattern, null without one. */
  testNamePattern: string | null;
}

export type RegistryRecord =
  ({ kind: 'call' } & CallRecord) | ({ kind: 'checked' } & CheckedRecord) | ({ kind: 'run' } & RunRecord);

/** Per container (`docker compose run --rm tools` — one per `./at api:test`); API_CALLS_FILE overrides it. */
export const CALLS_FILE = process.env.API_CALLS_FILE ?? join(tmpdir(), 'agrotrace-api-calls.ndjson');

const real = new WeakSet<object>();

/** Marks a response as received from the backend (ApiClient.request, lib/sse.ts). */
export function markReal<T extends object>(res: T): T {
  real.add(res);
  return res;
}

export const isReal = (res: object): boolean => real.has(res);

function persist(rec: RegistryRecord): void {
  appendFileSync(CALLS_FILE, `${JSON.stringify(rec)}\n`);
}

export function recordCall(rec: CallRecord): void {
  persist({ kind: 'call', ...rec });
}

export function recordChecked(rec: CheckedRecord): void {
  persist({ kind: 'checked', ...rec });
}

/** Every record of the current run (empty when the file does not exist). */
export function readRecords(file = CALLS_FILE): RegistryRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RegistryRecord);
}
