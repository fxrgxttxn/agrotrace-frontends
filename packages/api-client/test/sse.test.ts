// R33/Important 4: on `reauth`, close the EventSource, refresh, and reopen with the new
// access_token and lastEventId; on a plain (still-CONNECTING) network error, leave reconnection to
// EventSource itself; but once readyState reaches CLOSED — the browser has given up retrying on
// its own, e.g. an already-expired token rejected outright on the initial connect or a reconnect —
// refresh and re-attach ourselves, with bounded exponential backoff, stopping once refresh() fails.
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
    // Wait for the refresh() promise + reconnect to settle (real timers — reauth reconnects
    // immediately, with no backoff delay to advance).
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

      // A CLOSED error arriving right after close() (a late, already-in-flight failure) must not
      // schedule a reconnect, nor should any timer that *was* already scheduled before close() go
      // on to fire — either way, no refresh call and no new EventSource.
      first.fail();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(refresh).not.toHaveBeenCalled();
      expect(MockEventSource.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('Important 4: readyState CLOSED (not just a plain error) refreshes and re-attaches', () => {
    // Every CLOSED-driven reconnect (including the very first one) goes through the backoff delay
    // — unlike `reauth`, which is a deterministic signal and reconnects immediately — so all of
    // these use fake timers and advance explicitly rather than `vi.waitFor` (which polls on its
    // own real-time schedule and would either race the 1s+ delay or, worse, spin forever once fake
    // timers are already active in a test and nothing is advancing them).
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

        first.fail(); // e.g. the server rejected the connection: token already expired
        expect(MockEventSource.instances).toHaveLength(1); // not yet — waiting out the backoff
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
        // Called twice: once for the raw connection failure itself, once more for the terminal
        // "gave up trying to reconnect" signal once refresh() comes back empty-handed.
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
          expect(MockEventSource.instances).toHaveLength(before); // not yet — one ms short

          await vi.advanceTimersByTimeAsync(1);
          expect(MockEventSource.instances).toHaveLength(before + 1); // now, right on schedule
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

        // First failure -> reconnect after 1s (backoffIndex now advanced, next delay would be 2s).
        MockEventSource.instances[0]!.fail();
        await vi.advanceTimersByTimeAsync(1000);
        expect(MockEventSource.instances).toHaveLength(2);

        // This next connection succeeds (opens) before later failing...
        MockEventSource.instances[1]!.open();
        MockEventSource.instances[1]!.fail();

        // ...so the backoff must have reset to 1s, not continued at 2s.
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

        first.fail(); // -> refresh() rejects (attempt 1) -> scheduled for retry, not left dangling
        await vi.advanceTimersByTimeAsync(1000);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(MockEventSource.instances).toHaveLength(1); // still just the one, failed connection

        // Backoff has advanced to 2s for the next attempt.
        await vi.advanceTimersByTimeAsync(2000);

        expect(refresh).toHaveBeenCalledTimes(2);
        expect(MockEventSource.instances).toHaveLength(2); // recovered: a new stream was opened
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
        MockEventSource.instances[0]!.fail(); // failure #1 (the connection itself)

        // Drain every backoff step up to (and past) the give-up threshold: 1+2+4+8+16+30+30+30+30s
        // (the initial CLOSED failure, then refresh() rejecting 9 times in a row) ≈ 151s.
        await vi.advanceTimersByTimeAsync(160_000);

        expect(refresh).toHaveBeenCalledTimes(9); // failure #1 was the CLOSED connection, not a refresh call
        // Twice, as with a plain give-up (see the "stops... refresh returns null" test above):
        // once forwarding the initial CLOSED connection's raw error event, once more for the
        // terminal "gave up retrying" signal once the failure budget is exhausted.
        expect(onError).toHaveBeenCalledTimes(2);
        expect(MockEventSource.instances).toHaveLength(1); // never once opened a second EventSource
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
