import { http, HttpResponse } from 'msw';
import { API_BASE, contractExample, contractResponse } from './fromContract';

export const me = () => contractExample('getMe').body as Record<string, unknown>;
export const asMe = (patch: Record<string, unknown>) =>
  contractResponse('getMe', { body: { ...me(), ...patch } });

export const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  type: `/problems/${code.toLowerCase().replace(/_/g, '-')}`,
  title: code,
  status,
  code,
  ...extra,
});

export const pageOf = (items: unknown[], total = items.length, page = 1, size = 20) => ({
  items,
  page,
  size,
  total,
});

const stamp = { createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' };

export const REGIONS = [
  { id: '8c0e2a4c-6e8a-4c0e-9a4c-6e8a0c2e4a6c', code: '33', name: 'Владимирская область' },
  { id: '9d1f3b5d-7f9b-4d1f-8b5d-7f9b1d3f5b7d', code: '23', name: 'Краснодарский край' },
];
export const SUBSTANCES = [
  {
    id: '9e1f3a5b-7c9d-4e0f-a2b4-c6d8e0f2a4b6',
    name: 'Хлорпирифос',
    type: 'PESTICIDE',
    waitingPeriodDays: 30,
    ...stamp,
    deletedAt: null,
  },
  {
    id: 'ae2f4b6c-8d0e-4f1a-b3c5-d7e9f1a3b5c7',
    name: 'Аммиачная селитра',
    type: 'FERTILIZER',
    waitingPeriodDays: 0,
    ...stamp,
    deletedAt: null,
  },
];
export const PRODUCTS = [
  {
    id: '7a2b4c6d-8e0f-4a1b-9c3d-5e7f9a1b3c5d',
    name: 'Пшеница озимая',
    category: 'GRAIN',
    lossNormPercent: '2.00',
    mercuryCode: null,
    imageUrl: null,
    ...stamp,
    deletedAt: null,
  },
  {
    id: 'a4c6e8f0-2b4d-4f6a-8c0e-4b6d8f0a2c4e',
    name: 'Мука пшеничная высшего сорта',
    category: 'PROCESSED',
    lossNormPercent: '5.00',
    mercuryCode: null,
    imageUrl: null,
    ...stamp,
    deletedAt: null,
  },
];

export const dictionaries = () =>
  http.get(`${API_BASE}/dictionaries/:name`, ({ params }) => {
    const rows =
      { regions: REGIONS, substances: SUBSTANCES, products: PRODUCTS }[params.name as string] ?? [];
    return HttpResponse.json(pageOf(rows, rows.length, 1, 100));
  });

export function toastText(region: 'alert' | 'polite' = 'alert'): string {
  const sel = region === 'alert' ? '[role="alert"]' : '[aria-live="polite"]';
  return [...document.querySelectorAll(`.at-toast-region${sel} .at-toast__text`)]
    .map((n) => n.textContent)
    .join('|');
}

export const searchOf = (u: string) => (u.includes('?') ? '?' + u.split('?')[1] : '');
export const paramsOf = (u: string) => new URLSearchParams(searchOf(u));
export const pathOf = (u: string) => u.split('?')[0]!;
