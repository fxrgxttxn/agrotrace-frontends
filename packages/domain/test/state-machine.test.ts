import { describe, it, expect } from 'vitest';
import sm from '../../../contracts/rules/state-machine.json' with { type: 'json' };
import { availableActions, type BatchStatus } from '../src/index';

describe('availableActions', () => {
  it('returns exactly the {action, to} pairs declared for each status', () => {
    for (const status of sm.statuses as BatchStatus[]) {
      const expected = sm.transitions
        .filter((t) => t.from === status)
        .map(({ action, to }) => ({ action, to }));
      expect(availableActions(status)).toEqual(expected);
    }
  });

  it('returns an empty array for a terminal status with no outgoing transitions', () => {
    expect(availableActions('Sold')).toEqual([]);
  });

  it('returns multiple actions for a status with several outgoing transitions', () => {
    expect(availableActions('Accepted')).toEqual([
      { action: 'ship', to: 'InTransit' },
      { action: 'process', to: 'Processed' },
      { action: 'putOnSale', to: 'OnSale' },
      { action: 'recall', to: 'Recalled' },
    ]);
  });
});
