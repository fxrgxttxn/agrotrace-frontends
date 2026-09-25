/**
 * Organizations (contracts/openapi/paths/organizations.yaml): the card with visibility (own organization and direct
 * waybill counterparties; INSPECTOR and ADMIN — all; otherwise 404), the directory of ACTIVE organizations (R46),
 * the logo (JPEG/PNG/WebP → WebP 96/480, SVG sanitized and stored as is; head of the own organization or ADMIN; a
 * visible foreign organization → 403, an invisible one → 404) and its download.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { closeDb, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { fixture, MAX_IMAGE_BYTES, pngOfSize, RASTER, sha256hex, upload, webpSize } from './lib/files.js';
import { activateOrg, freshEmployee, freshHead, registerOrg } from './lib/fixtures.js';
import { closeRedis } from './lib/redis.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const ROLES: Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const UUID0 = '00000000-0000-4000-8000-000000000000';
const LOGO_TYPES = [...RASTER, 'image/svg+xml'];
const PUBLIC_URL = /^\/api\/v1\/public\/files\/([0-9a-f-]{36})$/;

async function getOrg(client: ApiClient, id: string) {
  const res = await client.get(`/organizations/${id}`);
  await expectContract(res, 'getOrganization');
  return res;
}

async function orgIdOf(client: ApiClient): Promise<string> {
  const me = await client.get('/me');
  return me.body.organization.id as string;
}

async function directory(client: ApiClient, q: Record<string, string | number> = {}, types: string[] = []) {
  const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
  for (const t of types) qs.append('type', t);
  const res = await client.get(`/organizations${qs.size ? `?${qs}` : ''}`);
  await expectContract(res, 'listOrganizations');
  return res;
}

async function uploadLogo(
  client: ApiClient,
  orgId: string,
  file: { data: Buffer | string; filename?: string; contentType?: string },
) {
  const res = await upload(client, `/organizations/${orgId}/logo`, file);
  await expectContract(res, 'uploadOrganizationLogo');
  return res;
}

async function getLogo(
  client: ApiClient,
  orgId: string,
  opts: { variant?: 96 | 480; headers?: Record<string, string> } = {},
) {
  const res = await client.get(`/organizations/${orgId}/logo`, {
    ...(opts.variant && { query: { variant: opts.variant } }),
    ...(opts.headers && { headers: opts.headers }),
  });
  await expectContract(res, 'getOrganizationLogo');
  return res;
}

async function publicFile(id: string, opts: { variant?: 96 | 480; headers?: Record<string, string> } = {}) {
  const res = await api().get(`/public/files/${id}`, {
    ...(opts.variant && { query: { variant: opts.variant } }),
    ...(opts.headers && { headers: opts.headers }),
  });
  await expectContract(res, 'downloadPublicFile');
  return res;
}

describe('getOrganization — visibility (п. 4.2)', () => {
  it('a participant sees the own organization and its direct waybill counterparties; others → 404', async () => {
    const farmer = await loginAs('FARMER', { key: 'zarya.head' });
    const zarya = await orgIdOf(farmer);
    const own = await getOrg(farmer, zarya);
    expect(own.status, own.text).toBe(200);
    expect(own.body).toMatchObject({ id: zarya, type: 'FARM', status: 'ACTIVE', region: { code: '33' } });
    expect(Number.isInteger(own.body.trustRating)).toBe(true);
    expect(own.body.logoUrl).toMatch(PUBLIC_URL);

    // TODO(Task 7): find the counterparty through the waybills API once it exists.
    const counterparties = await query<{ id: string }>(
      `SELECT DISTINCT receiver_org_id AS id FROM waybills
        WHERE sender_org_id = $1 AND deleted_at IS NULL`,
      [zarya],
    );
    expect(counterparties.length).toBeGreaterThan(0);
    for (const c of counterparties) {
      const res = await getOrg(farmer, c.id);
      expect(res.status, res.text).toBe(200);
      expect(res.body.trustRating).toBeNull(); // not a farm
    }

    const { org: stranger } = await freshHead('PROCESSOR');
    expectProblem(await getOrg(farmer, stranger.organizationId), 404, 'NOT_FOUND');
    const lab = await loginAs('LAB', { head: false });
    expectProblem(await getOrg(lab, zarya), 404, 'NOT_FOUND');
    expect((await getOrg(lab, await orgIdOf(lab))).status).toBe(200);
  });

  it.each(['INSPECTOR', 'ADMIN'] as Role[])('%s sees every organization, in any status', async (role) => {
    const client = await loginAs(role, { head: false });
    const pending = await registerOrg('FARM');
    const res = await getOrg(client, pending.organizationId);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'MANUAL_CHECK', logoUrl: null, trustRating: 80, address: null });
  });

  it('unknown id → 404, malformed id → 400, no token → 401', async () => {
    const admin = await loginAs('ADMIN');
    expectProblem(await getOrg(admin, UUID0), 404, 'NOT_FOUND');
    expectErrors(await getOrg(admin, 'abc'), { id: ['validation.uuid'] });
    expectProblem(await getOrg(api(), UUID0), 401, 'UNAUTHORIZED');
  });
});

describe('listOrganizations — directory (R46)', () => {
  it.each(ROLES)('%s: every ACTIVE organization except PLATFORM, own included, name asc', async (role) => {
    const client = await loginAs(role, { head: false });
    const res = await directory(client, { size: 100 });
    expect(res.status, res.text).toBe(200);
    const items = res.body.items as { id: string; type: string; name: string }[];
    expect(items.some((o) => o.type === 'PLATFORM')).toBe(false);
    // The own organization is listed too — except the platform itself (ADMIN's organization).
    if (role === 'ADMIN') expect(items.map((o) => o.id)).not.toContain(await orgIdOf(client));
    else expect(items.map((o) => o.id)).toContain(await orgIdOf(client));
    const names = items.map((o) => o.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('only ACTIVE: a registered organization appears once approved', async () => {
    const client = await loginAs('RETAILER');
    const name = `Аааа тестовая ${Date.now()}`;
    const org = await registerOrg('PROCESSOR', { name });
    expect((await directory(client, { q: name })).body.total).toBe(0);
    await activateOrg(org.organizationId);
    const found = await directory(client, { q: name });
    expect(found.body.items).toEqual([
      {
        id: org.organizationId,
        name,
        type: 'PROCESSOR',
        logoUrl: null,
        region: { code: '33', name: expect.any(String) },
      },
    ]);
  });

  it('filters: type (repeated), PLATFORM → empty, q = name or INN prefix (case-insensitive, % literal)', async () => {
    const client = await loginAs('FARMER');
    const two = await directory(client, { size: 100 }, ['LAB', 'RETAILER']);
    expect(new Set(two.body.items.map((o: { type: string }) => o.type))).toEqual(
      new Set(['LAB', 'RETAILER']),
    );
    const platform = await directory(client, {}, ['PLATFORM']);
    expect(platform.body).toMatchObject({ items: [], total: 0 });

    const prefix = await directory(client, { q: 'ооо «мол' });
    expect(prefix.body.items.map((o: { name: string }) => o.name).sort()).toEqual([
      'ООО «Молкомбинат Ставропольский»',
      'ООО «Молочная ферма Луговая»',
    ]);
    // prefix, not substring
    expect((await directory(client, { q: 'Молкомбинат' })).body.total).toBe(0);
    const byInn = await directory(client, { q: '23124500' });
    expect(byInn.body.items.map((o: { name: string }) => o.name)).toEqual(['ООО «Агрофирма Заря»']);
    expect((await directory(client, { q: '%' })).body.total).toBe(0);
  });

  it('sort name,desc; pages; invalid parameters → 400', async () => {
    const client = await loginAs('PROCESSOR');
    const desc = await directory(client, { sort: 'name,desc', size: 100 });
    const names = desc.body.items.map((o: { name: string }) => o.name);
    expect(names).toEqual([...names].sort((a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)));
    const p2 = await directory(client, { size: 3, page: 2 });
    expect(p2.body).toMatchObject({ page: 2, size: 3 });
    expect(p2.body.items.map((o: { id: string }) => o.id)).toEqual(
      (await directory(client, { size: 100 })).body.items.slice(3, 6).map((o: { id: string }) => o.id),
    );
    expectErrors(await directory(client, { sort: 'inn,asc' }), { sort: ['validation.sort'] });
    expectErrors(await directory(client, {}, ['ZOO']), { type: ['validation.enum'] });
    expectErrors(await directory(client, { q: '' }), { q: ['validation.minLength'] });
    expectErrors(await directory(client, { size: 0 }), { size: ['validation.min'] });
  });
});

describe('uploadOrganizationLogo', () => {
  it('head uploads PNG → public FileRef; WebP 480/96 via getOrganizationLogo and /public/files; audit', async () => {
    const { client, org, user } = await freshHead('FARM');
    const png = fixture('landscape-640x320.png');
    const res = await uploadLogo(client, org.organizationId, { data: png, filename: 'logo.png' });
    await expectContract(res, 'uploadOrganizationLogo');
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ mime: 'image/png', sizeBytes: png.length, originalName: 'logo.png' });
    expect(PUBLIC_URL.exec(res.body.url)?.[1]).toBe(res.body.id);
    expect((await getOrg(client, org.organizationId)).body.logoUrl).toBe(res.body.url);

    const logo = await getLogo(client, org.organizationId);
    await expectContract(logo, 'getOrganizationLogo');
    expect(logo.contentType).toBe('image/webp');
    expect(webpSize(logo.bytes)).toEqual({ width: 480, height: 240 });
    expect(logo.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    const small = await getLogo(client, org.organizationId, { variant: 96 });
    expect(webpSize(small.bytes)).toEqual({ width: 96, height: 48 });
    const pub = await publicFile(res.body.id, { variant: 96 });
    await expectContract(pub, 'downloadPublicFile');
    expect(pub.bytes.equals(small.bytes)).toBe(true);

    const audit = await query<{ entity_type: string; entity_id: string; diff: Record<string, unknown> }>(
      `SELECT entity_type, entity_id, diff FROM audit_log WHERE action = 'uploadOrganizationLogo' AND actor_id = $1
        ORDER BY id`,
      [user.id],
    );
    expect(audit.map((a) => a.entity_type).sort()).toEqual(['file', 'organization']);
    expect(audit.find((a) => a.entity_type === 'organization')).toMatchObject({
      entity_id: org.organizationId,
      diff: { logoFileId: [null, res.body.id] },
    });
  });

  it('SVG is sanitized (scripts, handlers, external references, foreignObject removed) and stored as SVG', async () => {
    const { client, org } = await freshHead('RETAILER');
    const res = await uploadLogo(client, org.organizationId, {
      data: fixture('logo-hostile.svg'),
      filename: 'logo.svg',
      contentType: 'image/svg+xml',
    });
    await expectContract(res, 'uploadOrganizationLogo');
    expect(res.status, res.text).toBe(200);
    expect(res.body.mime).toBe('image/svg+xml');

    const pub = await publicFile(res.body.id);
    await expectContract(pub, 'downloadPublicFile');
    expect(pub.contentType).toBe('image/svg+xml');
    const svg = pub.text;
    expect(res.body.sizeBytes).toBe(pub.bytes.length);
    expect(svg).toMatch(/^<svg[\s>]/);
    expect(svg).toContain('Безопасный текст');
    expect(svg).toContain('id="keep"');
    for (const bad of [
      '<script',
      'onload',
      'onclick',
      'onmouseover',
      'javascript:',
      'foreignObject',
      'evil.example',
      '<style',
      '@import',
      '<set',
      '<animate',
    ])
      expect(svg.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    // variant is ignored for SVG
    const v96 = await publicFile(res.body.id, { variant: 96 });
    expect(v96.bytes.equals(pub.bytes)).toBe(true);

    const clean = await uploadLogo(client, org.organizationId, {
      data: fixture('logo-clean.svg'),
      filename: 'c.svg',
    });
    expect(clean.status, clean.text).toBe(200);
    const cleanSvg = (await publicFile(clean.body.id)).text;
    for (const kept of ['viewBox="0 0 96 96"', '<linearGradient id="bg"', 'fill="url(#bg)"', 'ТЛ'])
      expect(cleanSvg).toContain(kept);
  });

  it('not well-formed SVG, DTD entities, text, PDF, fake PNG → 415 {allowed incl. SVG}', async () => {
    const { client, org } = await freshHead('FARM');
    for (const name of [
      'broken.svg',
      'entities.svg',
      'text-as-image.png',
      'document.pdf',
      'fake-signature.png',
    ]) {
      const res = await uploadLogo(client, org.organizationId, { data: fixture(name), filename: name });
      await expectContract(res, 'uploadOrganizationLogo');
      expectProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE', { allowed: LOGO_TYPES });
    }
  });

  it('Review Focus #5: exactly 2 097 152 bytes accepted, +1 → 413 {maxBytes}', async () => {
    const { client, org } = await freshHead('LAB');
    const ok = await uploadLogo(client, org.organizationId, {
      data: pngOfSize(MAX_IMAGE_BYTES),
      filename: 'x.png',
    });
    await expectContract(ok, 'uploadOrganizationLogo');
    expect(ok.status, ok.text).toBe(200);
    const over = await uploadLogo(client, org.organizationId, {
      data: pngOfSize(MAX_IMAGE_BYTES + 1),
      filename: 'y.png',
    });
    await expectContract(over, 'uploadOrganizationLogo');
    expectProblem(over, 413, 'FILE_TOO_LARGE', { maxBytes: MAX_IMAGE_BYTES });
  });

  it('replacing soft-deletes the old logo: its public URL → 404', async () => {
    const { client, org } = await freshHead('FARM');
    const first = await uploadLogo(client, org.organizationId, {
      data: fixture('tiny-40x20.png'),
      filename: 'a.png',
    });
    expect((await publicFile(first.body.id)).status).toBe(200);
    const second = await uploadLogo(client, org.organizationId, {
      data: fixture('logo-clean.svg'),
      filename: 'b.svg',
    });
    expect(second.status).toBe(200);
    const gone = await publicFile(first.body.id);
    await expectContract(gone, 'downloadPublicFile');
    expectProblem(gone, 404, 'NOT_FOUND');
  });

  it('who may upload: employee → 403; head of a visible foreign organization → 403; invisible → 404; ADMIN → any', async () => {
    const { client: head, org } = await freshHead('FARM');
    const emp = await freshEmployee(head, 'FARM');
    const png = { data: fixture('tiny-40x20.png'), filename: 'x.png' };
    const byEmployee = await uploadLogo(emp.client, org.organizationId, png);
    await expectContract(byEmployee, 'uploadOrganizationLogo');
    expectProblem(byEmployee, 403, 'FORBIDDEN', null);

    const zaryaHead = await loginAs('FARMER', { key: 'zarya.head' });
    const zarya = await orgIdOf(zaryaHead);
    const [counterparty] = await query<{ id: string }>(
      `SELECT receiver_org_id AS id FROM waybills WHERE sender_org_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [zarya],
    );
    const foreign = await uploadLogo(zaryaHead, counterparty!.id, png);
    await expectContract(foreign, 'uploadOrganizationLogo');
    expectProblem(foreign, 403, 'FORBIDDEN', null);
    const invisible = await uploadLogo(zaryaHead, org.organizationId, png);
    await expectContract(invisible, 'uploadOrganizationLogo');
    expectProblem(invisible, 404, 'NOT_FOUND');
    const unknown = await uploadLogo(zaryaHead, UUID0, png);
    expectProblem(unknown, 404, 'NOT_FOUND');

    const admin = await loginAs('ADMIN', { head: true });
    const byAdmin = await uploadLogo(admin, org.organizationId, png);
    await expectContract(byAdmin, 'uploadOrganizationLogo');
    expect(byAdmin.status, byAdmin.text).toBe(200);
  });
});

describe('getOrganizationLogo', () => {
  it('seeded SVG logo: image/svg+xml, Content-Disposition .svg, ETag = sha256, 304', async () => {
    const farmer = await loginAs('FARMER', { key: 'zarya.head' });
    const zarya = await orgIdOf(farmer);
    const res = await getLogo(farmer, zarya);
    await expectContract(res, 'getOrganizationLogo');
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('image/svg+xml');
    expect(res.headers.get('content-disposition')).toMatch(
      /^inline; filename="[^"]*\.svg"; filename\*=UTF-8''\S+\.svg$/,
    );
    const etag = res.headers.get('etag')!;
    expect(etag).toBe(`"${sha256hex(res.bytes)}"`);
    const again = await getLogo(farmer, zarya, { headers: { 'if-none-match': etag } });
    await expectContract(again, 'getOrganizationLogo');
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
  });

  it('no logo, invisible or unknown organization → 404', async () => {
    const { client, org } = await freshHead('FARM');
    expectProblem(await getLogo(client, org.organizationId), 404, 'NOT_FOUND');
    const lab = await loginAs('LAB');
    const res = await getLogo(lab, org.organizationId);
    await expectContract(res, 'getOrganizationLogo');
    expectProblem(res, 404, 'NOT_FOUND');
    expectProblem(await getLogo(lab, UUID0), 404, 'NOT_FOUND');
  });
});
