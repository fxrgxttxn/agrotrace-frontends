import type { Schemas } from '@agrotrace/api-client';
import type { Tone } from '../ui';

/** Colour group of a lab test status (README «Статус»: `data-tone` for other entities). */
export const LAB_STATUS_TONE: Record<Schemas['LabTestStatus'], Tone> = {
  QUEUED: 'attention',
  SAMPLED: 'move',
  DONE: 'ok',
  ESCALATED: 'danger',
  CANCELLED: 'neutral',
};

/** Colour group of a conclusion (BR-02). */
export const CONCLUSION_TONE: Record<Schemas['LabConclusion'], Tone> = { PASS: 'ok', FAIL: 'danger' };
