import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { server } from '../setup';
import { contractExample, contractResponse, type Json } from '../msw/fromContract';
import { asMe } from '../msw/data';
import { FakeEventSource, renderApp } from './renderApp';

const note = (type: string, payload: Json = {}) => ({
  id: 99,
  type,
  payload,
  readAt: null,
  createdAt: new Date().toISOString(),
});

async function counted(operationId: string, path: string, title: RegExp | string, extra: unknown[] = []) {
  const reads = { n: 0 };
  server.use(...(extra as never[]), contractResponse(operationId, { onRequest: () => void reads.n++ }));
  renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  await waitFor(() => expect(FakeEventSource.last).toBeDefined());
  await waitFor(() => expect(reads.n).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 50));
  return reads;
}

describe('live refresh of cards and the dashboard', () => {
  it('WAYBILL_INCOMING reads the waybill card again', async () => {
    const wb = contractExample('getWaybill').body as Json;
    const reads = await counted('getWaybill', `/waybills/${wb.id}`, /Накладная/);
    const before = reads.n;
    act(() => FakeEventSource.last!.emit('notification', note('WAYBILL_INCOMING', { waybillId: wb.id })));
    await waitFor(() => expect(reads.n).toBe(before + 1));
  });

  it('LAB_ASSIGNED reads the laboratory test card again', async () => {
    const test = contractExample('getLabTest').body as Json;
    const lab = { id: '5a7c9e1b-3d5f-4a7c-9e1b-3d5f7a9c1e3b', name: 'ИЛ', type: 'LAB', logoUrl: null };
    const reads = await counted('getLabTest', `/lab/tests/${test.id}`, /Анализ/, [
      asMe({ roles: ['LAB'], organization: lab }),
    ]);
    const before = reads.n;
    act(() => FakeEventSource.last!.emit('notification', note('LAB_ASSIGNED')));
    await waitFor(() => expect(reads.n).toBe(before + 1));
  });

  it('LAB_RESULT reads the dashboard again', async () => {
    const reads = await counted('getDashboard', '/', 'Панель');
    const before = reads.n;
    act(() => FakeEventSource.last!.emit('notification', note('LAB_RESULT')));
    await waitFor(() => expect(reads.n).toBe(before + 1));
  });

  it('a burst of notifications in one task reads the screen once', async () => {
    const reads = await counted('getDashboard', '/', 'Панель');
    const before = reads.n;
    act(() => {
      FakeEventSource.last!.emit('notification', note('LAB_RESULT'));
      FakeEventSource.last!.emit('notification', note('RECALL'));
      FakeEventSource.last!.emit('notification', note('OVERDUE'));
    });
    await waitFor(() => expect(reads.n).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 200));
    expect(reads.n).toBe(before + 1);
  });
});
