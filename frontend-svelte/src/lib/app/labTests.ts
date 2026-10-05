import type { Schemas } from '@agrotrace/api-client';
import type { Tone } from '../ui/display';

export const LAB_STATUS_TONE: Record<Schemas['LabTestStatus'], Tone> = {
  QUEUED: 'attention',
  SAMPLED: 'move',
  DONE: 'ok',
  ESCALATED: 'danger',
  CANCELLED: 'neutral',
};

export const CONCLUSION_TONE: Record<Schemas['LabConclusion'], Tone> = { PASS: 'ok', FAIL: 'danger' };
