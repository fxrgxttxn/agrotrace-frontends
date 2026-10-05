import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openEventStream } from '../src/sse';
import { MockEventSource } from './helpers';

beforeEach(() => {
  MockEventSource.reset();
});

describe('openEventStream', () => {
  it('opens with the current access_token in the query string', () => {
    const stream = openEventStream({
      baseUrl: '/api/v1',
      token: () => 'abc',
      onEvent: () => {},
      refresh: vi.fn(),
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });

    expect(MockEventSource.instances).toHaveLength(1);
    const url = new URL(MockEventSource.instances[0]!.url, 'http://localhost');
    expect(url.pathname).toBe('/api/v1/events/stream');
    expect(url.searchParams.get('access_token')).toBe('abc');
    expect(url.searchParams.has('lastEventId')).toBe(false);

    stream.close();
  });

  it('forwards notification and unread events, tracking the last event id', () => {
    const onEvent = vi.fn();
    openEventStream({
      token: () => 'abc',
      onEvent,
      refresh: vi.fn(),
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const source = MockEventSource.instances[0]!;

    source.emit('notification', { id: 'n1', seq: 1042 }, '1042');
    source.emit('unread', { count: 3 });

    expect(onEvent).toHaveBeenNthCalledWith(1, {
      type: 'notification',
      data: { id: 'n1', seq: 1042 },
      id: '1042',
    });
    expect(onEvent).toHaveBeenNthCalledWith(2, { type: 'unread', data: { count: 3 }, id: undefined });
  });

  it('on reauth: closes the stream, refreshes, and reopens with the new token and lastEventId', async () => {
    const onEvent = vi.fn();
    let token = 'old';
    const refresh = vi.fn(async () => {
      token = 'new';
      return token;
    });

    openEventStream({
      token: () => token,
      onEvent,
      refresh,
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const first = MockEventSource.instances[0]!;

    first.emit('notification', { seq: 7 }, '7');
    first.emit('reauth', { reason: 'TOKEN_EXPIRED' });

    expect(first.closed).toBe(true);
    await vi.waitFor(() => expect(MockEventSource.instances).toHaveLength(2));

    expect(refresh).toHaveBeenCalledTimes(1);
    const second = MockEventSource.instances[1]!;
    const url = new URL(second.url, 'http://localhost');
    expect(url.searchParams.get('access_token')).toBe('new');
    expect(url.searchParams.get('lastEventId')).toBe('7');
  });

  it('on reauth, surfaces onError instead of reconnecting when refresh fails', async () => {
    const onError = vi.fn();
    const refresh = vi.fn(async () => null);

    openEventStream({
      token: () => 'old',
      onEvent: () => {},
      onError,
      refresh,
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const first = MockEventSource.instances[0]!;

    first.emit('reauth', { reason: 'TOKEN_EXPIRED' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('does not close or reopen on a plain (still-CONNECTING) network error — left to EventSource auto-reconnect', () => {
    const onError = vi.fn();
    const refresh = vi.fn();

    openEventStream({
      token: () => 'old',
      onEvent: () => {},
      onError,
      refresh,
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const first = MockEventSource.instances[0]!;

    first.transientError();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(first.closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('close() closes the underlying EventSource and suppresses any further reconnect attempt', async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn(async () => 'new');
      const stream = openEventStream({
        token: () => 'old',
        onEvent: () => {},
        refresh,
        EventSourceImpl: MockEventSource as unknown as typeof EventSource,
      });
      const first = MockEventSource.instances[0]!;

      stream.close();
      expect(first.closed).toBe(true);

      first.fail();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(refresh).not.toHaveBeenCalled();
      expect(MockEventSource.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('Important 4: readyState CLOSED (not just a plain error) refreshes and re-attaches', () => {
    it('reconnects with the refreshed token, after the first backoff delay, when the very first connection is rejected outright', async () => {
      vi.useFakeTimers();
      try {
        let token = 'old-token';
        const refresh = vi.fn(async () => {
          token = 'new-token';
          return token;
        });

        openEventStream({
          token: () => token,
          onEvent: () => {},
          refresh,
          EventSourceImpl: MockEventSource as unknown as typeof EventSource,
        });
        const first = MockEventSource.instances[0]!;

        first.fail();
        expect(MockEventSource.instances).toHaveLength(1);
        expect(refresh).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1000);

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(MockEventSource.instances).toHaveLength(2);
        const second = MockEventSource.instances[1]!;
        expect(new URL(second.url, 'http://localhost').searchParams.get('access_token')).toBe('new-token');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops (surfacing onError) once refresh() returns null, without opening another EventSource', async () => {
      vi.useFakeTimers();
      try {
        const onError = vi.fn();
        const refresh = vi.fn(async () => null);

        openEventStream({
          token: () => 'old-token',
          onEvent: () => {},
          onError,
          refresh,
          EventSourceImpl: MockEventSource as unknown as typeof EventSource,
        });
        const first = MockEventSource.instances[0]!;

        first.fail();
        await vi.advanceTimersByTimeAsync(1000);

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(2);
        expect(MockEventSource.instances).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('backs off 1s, 2s, 4s, 8s across consecutive CLOSED failures that never manage to open', async () => {
      vi.useFakeTimers();
      try {
        let tokenSuffix = 0;
        const refresh = vi.fn(async () => `token-${++tokenSuffix}`);

        openEventStream({
          token: () => 'old-token',
          onEvent: () => {},
          refresh,
          EventSourceImpl: MockEventSource as unknown as typeof EventSource,
        });

        for (const delay of [1000, 2000, 4000, 8000]) {
          const before = MockEventSource.instances.length;
          MockEventSource.instances[before - 1]!.fail();

          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(MockEventSource.instances).toHaveLength(before);

          await vi.advanceTimersByTimeAsync(1);
          expect(MockEventSource.instances).toHaveLength(before + 1);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('resets the backoff to the first delay after a successful open', async () => {
      vi.useFakeTimers();
      try {
        let tokenSuffix = 0;
        const refresh = vi.fn(async () => `token-${++tokenSuffix}`);

        openEventStream({
          token: () => 'old-token',
          onEvent: () => {},
          refresh,
          EventSourceImpl: MockEventSource as unknown as typeof EventSource,
        });

        MockEventSource.instances[0]!.fail();
        await vi.advanceTimersByTimeAsync(1000);
        expect(MockEventSource.instances).toHaveLength(2);

        MockEventSource.instances[1]!.open();
        MockEventSource.instances[1]!.fail();

        await vi.advanceTimersByTimeAsync(999);
        expect(MockEventSource.instances).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(MockEventSource.instances).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('R63: a transient refresh() rejection (5xx/network — normal per R61) must not kill the stream', () => {
    it('recovers once refresh() stops rejecting: rejects once, then succeeds', async () => {
      vi.useFakeTimers();
      try {
        let attempt = 0;
        let token = 'old-token';
        const refresh = vi.fn(async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('backend restarting');
          token = 'recovered-token';
          return token;
        });

        openEventStream({
          token: () => token,
          onEvent: () => {},
          refresh,
          EventSourceImpl: MockEventSource as unknown as typeof EventSource,
        });
        const first = MockEventSource.instances[0]!;

        first.fail();
        await vi.advanceTimersByTimeAsync(1000);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(MockEventSource.instances).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(2000);

        expect(refresh).toHaveBeenCalledTimes(2);
        expect(MockEventSource.instances).toHaveLength(2);
        const second = MockEventSource.instances[1]!;
        expect(new URL(second.url, 'http://localhost').searchParams.get('access_token')).toBe(
          'recovered-token',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up (onError, no unhandled rejection) after 10 consecutive rejections, without ever opening', async () => {
      vi.useFakeTimers();
      try {
        const onError = vi.fn();
        const refresh = vi.fn(async () => {
          throw new Error('backend down');
        });

        openEventStream({
          token: () => 'old-token',
          onEvent: () => {},
          onError,
          refresh,
          EventSourceImpl: MockEventSource as unknown as typeof EventSource,
        });
        MockEventSource.instances[0]!.fail();

        await vi.advanceTimersByTimeAsync(160_000);

        expect(refresh).toHaveBeenCalledTimes(9);
        expect(onError).toHaveBeenCalledTimes(2);
        expect(MockEventSource.instances).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
