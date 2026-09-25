/**
 * Call registry for contract coverage (Task 14): every request (method, path, status) and every contract-checked
 * response (operationId, status) is recorded. With API_CALLS_FILE set, records are appended there as NDJSON so a
 * coverage report can aggregate all test files.
 */
import { appendFileSync } from 'node:fs';

export interface CallRecord {
  method: string;
  path: string;
  status: number;
}
export interface CheckedRecord {
  operationId: string;
  status: number;
}

export const calls: CallRecord[] = [];
export const checked: CheckedRecord[] = [];

function persist(kind: 'call' | 'checked', rec: object): void {
  const file = process.env.API_CALLS_FILE;
  if (file) appendFileSync(file, `${JSON.stringify({ kind, ...rec })}\n`);
}

export function recordCall(rec: CallRecord): void {
  calls.push(rec);
  persist('call', rec);
}

export function recordChecked(rec: CheckedRecord): void {
  checked.push(rec);
  persist('checked', rec);
}
