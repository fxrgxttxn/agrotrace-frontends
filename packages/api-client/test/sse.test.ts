// R33: on `reauth`, close the EventSource, refresh, and reopen with the new access_token and
// lastEventId; on a network error, leave reconnection to EventSource itself.
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

    expect(onEvent).toHaveBeenNthCalledWith(1, { type: 'notification', data: { id: 'n1', seq: 1042 }, id: '1042' });
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
    // Wait for the refresh() promise + reconnect to settle.
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

  it('does not close or reopen on a plain network error — left to EventSource auto-reconnect', () => {
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

    first.fail();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(first.closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('close() closes the underlying EventSource and stops further reconnects on reauth', () => {
    const stream = openEventStream({
      token: () => 'old',
      onEvent: () => {},
      refresh: vi.fn(async () => 'new'),
      EventSourceImpl: MockEventSource as unknown as typeof EventSource,
    });
    const first = MockEventSource.instances[0]!;

    stream.close();

    expect(first.closed).toBe(true);
  });
});
