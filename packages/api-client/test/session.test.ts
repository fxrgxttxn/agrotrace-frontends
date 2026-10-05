import { describe, expect, it, vi } from 'vitest';
import { createMemoryTokenStore } from '../src/session';

describe('createMemoryTokenStore', () => {
  it('starts with the given initial token (or null)', () => {
    expect(createMemoryTokenStore().get()).toBeNull();
    expect(createMemoryTokenStore('abc').get()).toBe('abc');
  });

  it('set() updates get() and notifies subscribers', () => {
    const store = createMemoryTokenStore(null);
    const fn = vi.fn();
    store.subscribe(fn);

    store.set('token-1');

    expect(store.get()).toBe('token-1');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('token-1');
  });

  it('unsubscribe stops further notifications', () => {
    const store = createMemoryTokenStore(null);
    const fn = vi.fn();
    const unsubscribe = store.subscribe(fn);

    unsubscribe();
    store.set('token-1');

    expect(fn).not.toHaveBeenCalled();
  });
});
