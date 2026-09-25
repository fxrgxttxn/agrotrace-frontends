import { sha256 } from '@noble/hashes/sha256';
import tr from '../../../contracts/rules/trust-rating.json' with { type: 'json' };
import { compareDecimalStrings, gramsToKg, kgToGrams, percentToBasisPoints, ratioPercent2 } from './decimal';
import { addDaysToDate, utcDate } from './dates';
import type { BatchStatus } from './state-machine';
import { compareCodePoints } from './strings';

/**
 * BR-01: a batch cannot ship until every treatment's waiting period has
 * elapsed. If several treatments still block, the one with the latest
 * `until` is reported; on a tie (R21), the substance with the smallest
 * name in Unicode code-point order is reported (compareCodePoints — not
 * `<`, which compares UTF-16 code units, and not localeCompare, which is
 * locale-dependent; R92).
 */
export function checkWaitingPeriod(i: {
  shipDate: string;
  treatments: { substance: string; appliedAt: string; waitingPeriodDays: number }[];
}): { ok: true } | { ok: false; until: string; substance: string } {
  let worst: { until: string; substance: string } | null = null;
  for (const t of i.treatments) {
    const until = addDaysToDate(utcDate(t.appliedAt), t.waitingPeriodDays);
    if (i.shipDate >= until) continue; // this treatment no longer blocks
    if (
      !worst ||
      until > worst.until ||
      (until === worst.until && compareCodePoints(t.substance, worst.substance) < 0)
    ) {
      worst = { until, substance: t.substance };
    }
  }
  return worst ? { ok: false, ...worst } : { ok: true };
}

/**
 * BR-02: any indicator whose value strictly exceeds its norm fails the
 * batch. Comparison is exact decimal (compareDecimalStrings), never
 * Number/parseFloat - see decimal.ts.
 */
export function concludeLabTest(i: {
  results: { indicatorId: string; value: string; maxValue: string | null }[];
}): { error: 'NO_RESULTS' } | { conclusion: 'PASS' | 'FAIL'; exceeded: string[] } {
  if (i.results.length === 0) return { error: 'NO_RESULTS' };
  const exceeded = i.results
    .filter((r) => r.maxValue !== null && compareDecimalStrings(r.value, r.maxValue) > 0)
    .map((r) => r.indicatorId);
  return { conclusion: exceeded.length ? 'FAIL' : 'PASS', exceeded };
}

/** sha256(utf8 publicCode) -> first 4 bytes as a big-endian uint32, mod 100. */
function sampleBucket(publicCode: string): number {
  const digest = sha256(new TextEncoder().encode(publicCode));
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  return view.getUint32(0, false) % 100;
}

/**
 * BR-03 risk model, checked in order: NEW_FARM, LOW_RATING,
 * RECENT_PESTICIDE, SAMPLED (deterministic 20% sample by public code hash),
 * else NONE.
 */
export function requiresLabTest(i: {
  publicCode: string;
  farmBatchCount: number;
  trustRating: number;
  pesticideTreatmentsLast30Days: number;
}): {
  required: boolean;
  reason: 'NEW_FARM' | 'LOW_RATING' | 'RECENT_PESTICIDE' | 'SAMPLED' | 'NONE';
} {
  if (i.farmBatchCount < 5) return { required: true, reason: 'NEW_FARM' };
  if (i.trustRating < 70) return { required: true, reason: 'LOW_RATING' };
  if (i.pesticideTreatmentsLast30Days > 0) return { required: true, reason: 'RECENT_PESTICIDE' };
  if (sampleBucket(i.publicCode) < 20) return { required: true, reason: 'SAMPLED' };
  return { required: false, reason: 'NONE' };
}

/**
 * BR-04: total output mass must not exceed total input mass minus normative
 * product loss, computed exactly in grams. inputs are checked before
 * outputs, so both empty reports NO_INPUTS (R23).
 */
export function checkMassBalance(i: {
  inputs: { massUsedKg: string; lossNormPercent: string }[];
  outputs: { massKg: string }[];
}):
  | { error: 'NO_INPUTS' | 'NO_OUTPUTS' }
  | { ok: boolean; inputKg: string; allowedKg: string; outputKg: string } {
  if (i.inputs.length === 0) return { error: 'NO_INPUTS' };
  if (i.outputs.length === 0) return { error: 'NO_OUTPUTS' };
  let input = 0n;
  let allowed = 0n;
  let output = 0n;
  for (const x of i.inputs) {
    const g = kgToGrams(x.massUsedKg);
    input += g;
    allowed += (g * (10000n - percentToBasisPoints(x.lossNormPercent))) / 10000n;
  }
  for (const o of i.outputs) output += kgToGrams(o.massKg);
  return {
    ok: output <= allowed,
    inputKg: gramsToKg(input),
    allowedKg: gramsToKg(allowed),
    outputKg: gramsToKg(output),
  };
}

/**
 * BR-05: eligibility as processing input. Sale eligibility is governed
 * separately by the state machine (R20: putOnSale is only reachable from
 * Accepted).
 */
export function canUseAsInput(i: { status: BatchStatus }): { allowed: boolean } {
  return { allowed: i.status === 'Approved' || i.status === 'Accepted' };
}

/**
 * BR-07: declaredKg "0.000" is rejected as DECLARED_ZERO instead of
 * dividing by zero (R22). actRequired is computed exactly in grams
 * (integers), independent of the rounded display percent.
 */
export function checkDiscrepancy(i: {
  declaredKg: string;
  actualKg: string;
}): { error: 'DECLARED_ZERO' } | { percent: string; actRequired: boolean } {
  const d = kgToGrams(i.declaredKg);
  if (d === 0n) return { error: 'DECLARED_ZERO' };
  const a = kgToGrams(i.actualKg);
  const diff = a > d ? a - d : d - a;
  return { percent: ratioPercent2(diff, d), actRequired: diff * 100n > 2n * d };
}

/** BR-09: farm trust rating recalculation, clamped to [tr.min, tr.max]. */
export function nextTrustRating(i: { current: number; event: keyof typeof tr.deltas }): { rating: number } {
  return { rating: Math.min(tr.max, Math.max(tr.min, Math.round(i.current + tr.deltas[i.event]))) };
}

/** BR-10: a recall closes once every attached task is CONFIRMED (vacuous on empty). */
export function shouldCloseRecall(i: { taskStatuses: string[] }): { close: boolean } {
  return { close: i.taskStatuses.every((s) => s === 'CONFIRMED') };
}

/** Public batch code AT-{year}-{seq}, seq zero-padded to at least 6 digits. */
export function formatBatchCode(i: { year: number; seq: number }): { code: string } {
  return { code: `AT-${i.year}-${String(i.seq).padStart(6, '0')}` };
}
