import type { Schemas } from '@agrotrace/api-client';

export type BatchItem = Schemas['BatchListItem'];
export const STEPS = ['inputs', 'outputs', 'balance'] as const;
export type Step = (typeof STEPS)[number];
/** Contract `Mass` pattern (`PositiveMass`/`Mass`): up to 9 integer digits, exactly 3 decimals. */
export const MASS = /^\d{1,9}\.\d{3}$/;
