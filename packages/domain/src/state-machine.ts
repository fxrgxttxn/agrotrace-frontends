import sm from '../../../contracts/rules/state-machine.json' with { type: 'json' };

export type BatchStatus =
  | 'Created'
  | 'OnTest'
  | 'Approved'
  | 'InTransit'
  | 'Accepted'
  | 'Processed'
  | 'OnSale'
  | 'Sold'
  | 'Blocked'
  | 'Recalled'
  | 'WrittenOff';

export const BATCH_STATUSES = sm.statuses as readonly BatchStatus[];

const T = sm.transitions as { from: BatchStatus; to: BatchStatus; action: string }[];

export function canTransition(i: { from: BatchStatus; to: BatchStatus }): { allowed: boolean } {
  return { allowed: T.some((t) => t.from === i.from && t.to === i.to) };
}

export function availableActions(from: BatchStatus): { action: string; to: BatchStatus }[] {
  return T.filter((t) => t.from === from).map(({ action, to }) => ({ action, to }));
}
