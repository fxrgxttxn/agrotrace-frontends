import { describe, expect, it, vi } from 'vitest';
import { firstValueFrom, take, toArray } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import type { StreamEvent } from '@agrotrace/api-client';
import { server } from '../setup';
import { contractExample, contractResponse } from '../msw/fromContract';
import { EVENT_SOURCE, LiveEventsService } from '../../src/app/live-events';
import { createSessionCore, SESSION_CORE, SessionService } from '../../src/app/session';
import { FakeEventSource } from './renderApp';

const TOKEN = (contractExample('refreshToken').body as { accessToken: string }).accessToken;

function setup() {
  server.use(contractResponse('refreshToken', { status: 401, once: true }));
  const core = createSessionCore();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'login', children: [] }]),
      provideHttpClient(),
      { provide: SESSION_CORE, useValue: core },
      { provide: EVENT_SOURCE, useValue: FakeEventSource as unknown as typeof EventSource },
    ],
  });
  const session = TestBed.inject(SessionService);
  const live = TestBed.inject(LiveEventsService);
  return { core, session, live };
}

const params = (es: FakeEventSource) => new URL(es.url).searchParams;

describe('LiveEventsService.events()', () => {
  it('opens GET /events/stream with the access token and emits parsed events', async () => {
    const { core, session, live } = setup();
    await session.settled();
    core.store.set('first-token');
    const got = firstValueFrom(live.events().pipe(take(2), toArray()));
    const es = FakeEventSource.last!;
    expect(new URL(es.url).pathname).toBe('/api/v1/events/stream');
    expect(params(es).get('access_token')).toBe('first-token');
    es.emit('unread', { count: 4 });
    es.emit('notification', { id: 'x', seq: 17 }, '17');
    expect(await got).toEqual<StreamEvent[]>([
      { type: 'unread', data: { count: 4 }, id: undefined },
      { type: 'notification', data: { id: 'x', seq: 17 }, id: '17' },
    ]);
    core.api.dispose();
  });

  it('nothing is opened until subscribed; unsubscribing closes the stream', async () => {
    const { core, session, live } = setup();
    await session.settled();
    const events = live.events();
    expect(FakeEventSource.instances).toHaveLength(0);
    const sub = events.subscribe();
    const es = FakeEventSource.last!;
    expect(es.readyState).not.toBe(FakeEventSource.CLOSED);
    sub.unsubscribe();
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
    core.api.dispose();
  });

  it('`reauth`: closes, refreshes once, reopens with the new token and the last notification id', async () => {
    const { core, session, live } = setup();
    await session.settled();
    const refresh = vi.fn();
    server.use(contractResponse('refreshToken', { onRequest: () => refresh() }));
    core.store.set('first-token');
    const sub = live.events().subscribe();
    const first = FakeEventSource.last!;
    first.emit('notification', { id: 'x', seq: 41 }, '41');
    first.emit('reauth', { reason: 'TOKEN_EXPIRED' });
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const second = FakeEventSource.last!;
    expect(params(second).get('access_token')).toBe(TOKEN);
    expect(params(second).get('lastEventId')).toBe('41');
    expect(refresh).toHaveBeenCalledTimes(1);
    sub.unsubscribe();
    core.api.dispose();
  });

  it('the service opens the stream only while signed in and resets the counter on sign-out', async () => {
    const { core, session, live } = setup();
    await session.settled();
    expect(FakeEventSource.instances).toHaveLength(0);
    session.signIn(contractExample('login').body as never);
    const es = FakeEventSource.last!;
    es.emit('unread', { count: 5 });
    expect(live.unread()).toBe(5);
    await session.signOut();
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
    expect(live.unread()).toBe(0);
    core.api.dispose();
  });
});
