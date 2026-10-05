import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/svelte';
import type { StreamEvent } from '@agrotrace/api-client';
import { server } from '../setup';
import { contractExample, contractResponse } from '../msw/fromContract';
import { eventStream, live } from '../../src/lib/app/live.svelte';
import { Session } from '../../src/lib/app/session.svelte';
import { FakeEventSource } from './renderApp';

const TOKEN = (contractExample('refreshToken').body as { accessToken: string }).accessToken;
const sessions: Session[] = [];

function setup() {
  const session = new Session();
  sessions.push(session);
  session.store.set('first-token');
  const events: StreamEvent[] = [];
  const close = eventStream(session, (e) => events.push(e), {
    EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
  });
  return { session, events, close };
}

const params = (es: FakeEventSource) => new URL(es.url).searchParams;

afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});

describe('eventStream', () => {
  it('opens GET /events/stream with the access token and forwards parsed events', () => {
    const { events } = setup();
    const es = FakeEventSource.last!;
    expect(new URL(es.url).pathname).toBe('/api/v1/events/stream');
    expect(params(es).get('access_token')).toBe('first-token');
    es.emit('unread', { count: 4 });
    es.emit('notification', { id: 'x', seq: 17 }, '17');
    expect(events).toEqual([
      { type: 'unread', data: { count: 4 }, id: undefined },
      { type: 'notification', data: { id: 'x', seq: 17 }, id: '17' },
    ]);
  });

  it('closing closes the open stream', () => {
    const { close } = setup();
    const es = FakeEventSource.last!;
    expect(es.readyState).not.toBe(FakeEventSource.CLOSED);
    close();
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('`reauth`: closes, refreshes once, reopens with the new token and the last notification id', async () => {
    const refresh = vi.fn();
    server.use(contractResponse('refreshToken', { onRequest: () => refresh() }));
    setup();
    const first = FakeEventSource.last!;
    first.emit('notification', { id: 'x', seq: 41 }, '41');
    first.emit('reauth', { reason: 'TOKEN_EXPIRED' });
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const second = FakeEventSource.last!;
    expect(params(second).get('access_token')).toBe(TOKEN);
    expect(params(second).get('lastEventId')).toBe('41');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('live store', () => {
  it('keeps the unread counter and resets it when disconnected', () => {
    const session = new Session();
    sessions.push(session);
    session.store.set('t');
    live.EventSourceImpl = FakeEventSource as unknown as typeof EventSource;
    const stop = live.connect(session);
    FakeEventSource.last!.emit('unread', { count: 5 });
    expect(live.unread).toBe(5);
    FakeEventSource.last!.emit('unread', { count: -1 });
    expect(live.unread).toBe(5);
    stop();
    expect(live.unread).toBe(0);
    expect(FakeEventSource.last!.readyState).toBe(FakeEventSource.CLOSED);
  });
});
