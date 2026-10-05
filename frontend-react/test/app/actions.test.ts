import { describe, expect, it } from 'vitest';
import { noteInput, rescueWindow, runPassive, trackRequest } from '../../src/app/actions';

describe('runPassive', () => {
  it('several marks in one task all end: a later own request is the person\u2019s again', async () => {
    runPassive(() => {});
    runPassive(() => {});
    runPassive(() => {});
    await new Promise((r) => setTimeout(r, 10));
    noteInput();
    await trackRequest(() => Promise.resolve(1));
    expect(rescueWindow()).toBe(true);
  });
});
