import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { StreamEvent } from '@agrotrace/api-client';
import { server } from '../setup';
import { contractExample, contractResponse } from '../msw/fromContract';
import { AppProviders, createQueryClient } from '../../src/app/providers';
import { createSessionCore, SessionProvider } from '../../src/app/session';
import { useEventSource } from '../../src/app/sse';
import { ROUTER_FUTURE } from '../../src/app/router';
import { FakeEventSource } from './renderApp';

const TOKEN = (contractExample('refreshToken').body as { accessToken: string }).accessToken;

function setup(enabled: boolean) {
  const core = createSessionCore();
  core.store.set('first-token');
  const events: StreamEvent[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter future={ROUTER_FUTURE}>
      <AppProviders queryClient={createQueryClient()}>
        <SessionProvider core={core}>{children}</SessionProvider>
      </AppProviders>
    </MemoryRouter>
  );
  const hook = renderHook(
    ({ on }: { on: boolean }) =>
      useEventSource(on, (e) => events.push(e), {
        EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    { wrapper, initialProps: { on: enabled } },
  );
  return { ...hook, events, core };
}

const params = (es: FakeEventSource) => new URL(es.url).searchParams;

describe('useEventSource', () => {
  it('opens GET /events/stream with the access token and forwards parsed events', () => {
    const { events, core } = setup(true);
    const es = FakeEventSource.last!;
    expect(new URL(es.url).pathname).toBe('/api/v1/events/stream');
    expect(params(es).get('access_token')).toBe('first-token');
    act(() => es.emit('unread', { count: 4 }));
    act(() => es.emit('notification', { id: 'x', seq: 17 }, '17'));
    expect(events).toEqual([
      { type: 'unread', data: { count: 4 }, id: undefined },
      { type: 'notification', data: { id: 'x', seq: 17 }, id: '17' },
    ]);
    core.api.dispose();
  });

  it('does nothing while disabled; disabling closes the open stream', () => {
    const { rerender, core } = setup(false);
    expect(FakeEventSource.instances).toHaveLength(0);
    rerender({ on: true });
    const es = FakeEventSource.last!;
    expect(es.readyState).not.toBe(FakeEventSource.CLOSED);
    rerender({ on: false });
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
    core.api.dispose();
  });

  it('`reauth`: closes, refreshes once, reopens with the new token and the last notification id', async () => {
    const refresh = vi.fn();
    server.use(contractResponse('refreshToken', { onRequest: () => refresh() }));
    const { core } = setup(true);
    const first = FakeEventSource.last!;
    act(() => first.emit('notification', { id: 'x', seq: 41 }, '41'));
    act(() => first.emit('reauth', { reason: 'TOKEN_EXPIRED' }));
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const second = FakeEventSource.last!;
    expect(params(second).get('access_token')).toBe(TOKEN);
    expect(params(second).get('lastEventId')).toBe('41');
    expect(refresh).toHaveBeenCalledTimes(1);
    core.api.dispose();
  });

  it('unmounting closes the stream', () => {
    const { unmount, core } = setup(true);
    const es = FakeEventSource.last!;
    unmount();
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
    core.api.dispose();
  });
});
