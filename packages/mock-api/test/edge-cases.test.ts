import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../src/index.js';
import { nodeAssetLoader } from './helpers/assets.js';
import { BASE, expectStatus } from './helpers/client.js';
import { useMock } from './helpers/mock.js';

const mock = useMock();
const s = () => mock.api.store;
const lastAudit = () => s().t.audit_log.at(-1)!;
const swapped = (diff: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, [(v as unknown[])[1], (v as unknown[])[0]]]));

describe('permanent delete audit (norms, regions)', () => {
  it('norm: productId, indicatorId and maxValue → [before, null], the mirror of the creation', async () => {
    const t = await mock.login('admin@agrotrace.test');
    const norm = s().t.norms[0]!;
    await expectStatus(204, 'DELETE', `/dictionaries/norms/${norm.id}`, { token: t });
    expect(lastAudit()).toMatchObject({
      action: 'deleteDictionaryEntry',
      entity_type: 'norm',
      entity_id: norm.id,
    });
    expect(lastAudit().diff).toEqual({
      productId: [norm.product_id, null],
      indicatorId: [norm.indicator_id, null],
      maxValue: [norm.max_value, null],
    });

    const created = (
      await expectStatus(201, 'POST', '/dictionaries/norms', {
        token: t,
        body: { productId: norm.product_id, indicatorId: norm.indicator_id, maxValue: '7.5' },
      })
    ).body;
    const creation = lastAudit().diff;
    expect(Object.keys(creation).sort()).toEqual(['indicatorId', 'maxValue', 'productId']);
    await expectStatus(204, 'DELETE', `/dictionaries/norms/${created.id}`, { token: t });
    expect(lastAudit().diff).toEqual(swapped(creation));
  });

  it('region: code and name → [before, null]', async () => {
    const t = await mock.login('admin@agrotrace.test');
    const r = (
      await expectStatus(201, 'POST', '/dictionaries/regions', {
        token: t,
        body: { code: '98', name: 'Тестовый край' },
      })
    ).body;
    const creation = lastAudit().diff;
    await expectStatus(204, 'DELETE', `/dictionaries/regions/${r.id}`, { token: t });
    expect(lastAudit()).toMatchObject({ entity_type: 'region', entity_id: r.id });
    expect(lastAudit().diff).toEqual({ code: ['98', null], name: ['Тестовый край', null] });
    expect(lastAudit().diff).toEqual(swapped(creation));
  });
});

describe('a download aborted with the document (pagehide) logs nothing', () => {
  async function setup() {
    const page = new EventTarget();
    let aborting = false;
    const api = createMockApi({
      now: () => Date.parse('2026-10-14T10:00:00Z'),
      loadAsset: (url) =>
        aborting ? Promise.reject(new TypeError('Failed to fetch')) : nodeAssetLoader(url),
      rateLimits: false,
      persist: false,
      blobStore: null,
      lock: null,
      lifecycle: page,
    });
    await api.ready;
    const photo = api.store.t.files.find((f) => f.kind === 'PRODUCT_IMAGE' && f.deleted_at === null)!;
    const download = () => api.handle(new Request(`${BASE}/public/files/${photo.id}`));
    expect((await download()).status).toBe(200);
    aborting = true;
    return { api, page, download };
  }

  it('after pagehide: 500 without a console error; a failure while the page is shown is still logged', async () => {
    const { api, page, download } = await setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await download()).status).toBe(500);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![1])).toBe('downloadPublicFile');

      page.dispatchEvent(new Event('pagehide'));
      expect((await download()).status).toBe(500);
      expect(errors).toHaveBeenCalledTimes(1);

      page.dispatchEvent(new Event('pageshow'));
      await download();
      expect(errors).toHaveBeenCalledTimes(2);

      api.dispose();
      page.dispatchEvent(new Event('pagehide'));
      await download();
      expect(errors).toHaveBeenCalledTimes(3);
    } finally {
      errors.mockRestore();
    }
  });
});
