/**
 * Files (contracts/openapi/paths/files.yaml, public.yaml#downloadPublicFile; R28/R34/R39/R88): Bearer access with the
 * entity's rights, signed URLs without Bearer (403 for a bad/expired/partial signature, `variant` not signed, the
 * Authorization header ignored when a signature is present), 401 without either, ETag = sha256 of the served bytes and
 * 304, Content-Disposition (RFC 5987), Cache-Control per access type; public images without authorization (logos,
 * product photos), everything else → 404 there.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { loginAs } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { closeDb, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import {
  apiPath,
  contentDisposition,
  fileIdOf,
  fixture,
  sha256hex,
  signature,
  upload,
  webpSize,
} from './lib/files.js';
import { freshHead, login } from './lib/fixtures.js';
import { closeRedis } from './lib/redis.js';
import { DEMO_PASSWORD } from '../../db/seed/src/data.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const UUID0 = '00000000-0000-4000-8000-000000000000';
const PRIVATE = 'private, max-age=0, must-revalidate';
const PUBLIC = 'public, max-age=86400';

/** The file id of a seeded product photo, from listDictionary (products.imageUrl). */
async function productPhoto(client: ApiClient): Promise<{ id: string }> {
  const res = await client.get('/dictionaries/products', { query: { size: 100 } });
  await expectContract(res, 'listDictionary');
  expect(res.status, res.text).toBe(200);
  const withImage = (res.body.items as { imageUrl: string | null }[]).find((p) => p.imageUrl !== null);
  if (!withImage) throw new Error('no seeded product has a photo');
  return { id: fileIdOf(withImage.imageUrl!) };
}

/** A fresh head with an uploaded avatar: { client, fileId, url (signed), originalName }. */
async function withAvatar(originalName = 'Портрет «Петров» 2026.png') {
  const { client, user } = await freshHead('FARM');
  const res = await upload(client, '/me/avatar', {
    data: fixture('landscape-640x320.png'),
    filename: originalName,
  });
  await expectContract(res, 'uploadMyAvatar');
  expect(res.status, res.text).toBe(200);
  return { client, user, fileId: res.body.id as string, url: res.body.url as string, originalName };
}

async function download(client: ApiClient, path: string, headers: Record<string, string> = {}) {
  const res = await client.get(path, { headers });
  await expectContract(res, 'downloadFile');
  return res;
}

describe('downloadFile — Bearer', () => {
  it('an avatar is served to any authenticated user: WebP, headers per the contract', async () => {
    const { fileId, originalName } = await withAvatar();
    const viewer = await loginAs('RETAILER', { head: false });
    const res = await download(viewer, `/files/${fileId}`);
    expect(res.status, res.text).toBe(200);
    expect(res.contentType).toBe('image/webp');
    expect(webpSize(res.bytes)).toEqual({ width: 480, height: 240 });
    expect(res.headers.get('etag')).toBe(`"${sha256hex(res.bytes)}"`);
    expect(res.headers.get('cache-control')).toBe(PRIVATE);
    expect(Number(res.headers.get('content-length'))).toBe(res.bytes.length);
    expect(res.headers.get('content-disposition')).toBe(contentDisposition(originalName, 'webp'));
  });

  it('logos and product photos are served to any role; an unknown file → 404; malformed id/variant → 400', async () => {
    const lab = await loginAs('LAB', { head: false });
    const product = await productPhoto(lab);
    const photo = await download(lab, `/files/${product!.id}`);
    expect(photo.status, photo.text).toBe(200);
    expect(photo.contentType).toBe('image/webp');
    expect(Math.max(...Object.values(webpSize(photo.bytes)))).toBeLessThanOrEqual(480);

    const me = await lab.get('/me');
    const logo = await download(lab, `/files/${fileIdOf(me.body.organization.logoUrl)}`);
    expect(logo.status).toBe(200);
    expect(logo.contentType).toBe('image/svg+xml');

    expectProblem(await download(lab, `/files/${UUID0}`), 404, 'NOT_FOUND');
    expectErrors(await download(lab, '/files/xyz'), { id: ['validation.uuid'] });
    expectErrors(await download(lab, `/files/${product!.id}?variant=128`), { variant: ['validation.enum'] });
  });

  it('a lab protocol inherits the lab test rights: its lab and INSPECTOR → 200, an unrelated FARMER → 404', async () => {
    // TODO(Task 9): the protocol URL and its laboratory through the lab API once it exists.
    const [row] = await query<{ id: string; email: string }>(
      `SELECT t.protocol_file_id AS id, u.email FROM lab_tests t JOIN users u ON u.organization_id = t.lab_org_id
        WHERE t.protocol_file_id IS NOT NULL AND u.status = 'ACTIVE' ORDER BY t.id LIMIT 1`,
    );
    const labUser = api();
    expect((await login(labUser, row!.email, DEMO_PASSWORD)).status).toBe(200);
    const own = await download(labUser, `/files/${row!.id}`);
    expect(own.status, own.text).toBe(200);
    expect(own.contentType).toBe('application/pdf');
    expect(own.headers.get('content-disposition')).toMatch(/\.pdf$/);
    expect(own.headers.get('etag')).toBe(`"${sha256hex(own.bytes)}"`);
    expect((await download(await loginAs('INSPECTOR', { head: false }), `/files/${row!.id}`)).status).toBe(
      200,
    );
    const { client: stranger } = await freshHead('FARM');
    expectProblem(await download(stranger, `/files/${row!.id}`), 404, 'NOT_FOUND');
  });

  it('no Bearer and no signature → 401', async () => {
    const { fileId } = await withAvatar();
    expectProblem(await download(api(), `/files/${fileId}`), 401, 'UNAUTHORIZED');
    expectProblem(
      await download(api(), `/files/${fileId}`, { authorization: 'Bearer not.a.token' }),
      401,
      'UNAUTHORIZED',
    );
  });
});

describe('downloadFile — signed URL (R28, R39, R88 M2)', () => {
  it('works without Authorization; variant may be added or replaced (not signed)', async () => {
    const { url } = await withAvatar();
    const res = await download(api(), apiPath(url));
    expect(res.status, res.text).toBe(200);
    expect(webpSize(res.bytes)).toEqual({ width: 480, height: 240 });
    expect(res.headers.get('cache-control')).toBe(PRIVATE);
    const small = await download(api(), `${apiPath(url)}&variant=96`);
    expect(webpSize(small.bytes)).toEqual({ width: 96, height: 48 });
    const replaced = await download(api(), `${apiPath(url)}&variant=96`.replace('variant=96', 'variant=480'));
    expect(replaced.bytes.equals(res.bytes)).toBe(true);
  });

  it('the URL follows the contract recipe (sig = HMAC(fileUrlKey, "{id}:{exp}"), exp = issue time + 3600)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { url, fileId } = await withAvatar();
    const u = new URL(url, 'http://x');
    const exp = Number(u.searchParams.get('exp'));
    expect(exp).toBeGreaterThanOrEqual(before + 3600);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600);
    expect(u.searchParams.get('sig')).toBe(signature(fileId, exp));
  });

  it('bad, expired or partial signature → 403 FORBIDDEN (rights are not checked, Bearer is ignored)', async () => {
    const { fileId, client } = await withAvatar();
    const future = Math.floor(Date.now() / 1000) + 600;
    const past = Math.floor(Date.now() / 1000) - 5;
    const good = signature(fileId, future);
    const cases = [
      `/files/${fileId}?exp=${future}&sig=${good.replace(/^./, (c) => (c === '0' ? '1' : '0'))}`,
      `/files/${fileId}?exp=${future + 1}&sig=${good}`,
      `/files/${fileId}?exp=${past}&sig=${signature(fileId, past)}`,
      `/files/${fileId}?exp=${future}`,
      `/files/${fileId}?sig=${good}`,
      `/files/${fileId}?exp=soon&sig=${good}`,
      // P17: exp exactly as issued — a leading zero is another string even with the same numeric value
      `/files/${fileId}?exp=0${future}&sig=${good}`,
      `/files/${fileId}?exp=${future}&sig=${good.toUpperCase()}`,
      `/files/${UUID0}?exp=${future}&sig=${good}`,
    ];
    for (const path of cases) {
      // with a valid Bearer too: a signature, once present, is the only thing checked
      for (const who of [api(), client]) expectProblem(await download(who, path), 403, 'FORBIDDEN');
    }
    // a valid signature with a garbage Authorization header still works
    const ok = await download(api(), `/files/${fileId}?exp=${future}&sig=${good}`, {
      authorization: 'Bearer x.y.z',
    });
    expect(ok.status, ok.text).toBe(200);
  });

  it('a signed URL of a deleted file → 404', async () => {
    const { client, url } = await withAvatar();
    expect((await client.delete('/me/avatar')).status).toBe(204);
    expectProblem(await download(api(), apiPath(url)), 404, 'NOT_FOUND');
  });
});

describe('ETag / If-None-Match', () => {
  it('304 with the same ETag and Cache-Control, no body; weak and list forms; another tag → 200', async () => {
    const { url } = await withAvatar();
    const first = await download(api(), apiPath(url));
    const etag = first.headers.get('etag')!;
    for (const inm of [etag, `W/${etag}`, `"0000", ${etag}`, '*']) {
      const res = await download(api(), apiPath(url), { 'if-none-match': inm });
      expect(res.status, inm).toBe(304);
      expect(res.bytes.length).toBe(0);
      expect(res.headers.get('etag')).toBe(etag);
      expect(res.headers.get('cache-control')).toBe(PRIVATE);
    }
    const other = await download(api(), `${apiPath(url)}&variant=96`, { 'if-none-match': etag });
    expect(other.status).toBe(200);
    expect(other.headers.get('etag')).not.toBe(etag);
  });
});

describe('Content-Disposition (R34)', () => {
  it.each([
    ['plain.png', 'webp'],
    ['Фото поля №1.jpeg', 'webp'],
    ['quote"and\'apos(1).png', 'webp'],
    ['no-extension', 'webp'],
  ])('%s → the served extension, ASCII fallback and RFC 5987 form', async (name, ext) => {
    const { url, originalName } = await withAvatar(name);
    const res = await download(api(), apiPath(url));
    // multipart filenames escape `"` as %22 (HTML form rules): that is the name the server receives
    expect(res.headers.get('content-disposition')).toBe(
      contentDisposition(originalName.replace(/"/g, '%22'), ext),
    );
  });

  it('a raw `"` (quoted-string escape) reaches originalName and becomes `_` in the ASCII form', async () => {
    const { client } = await freshHead('FARM');
    const res = await upload(client, '/me/avatar', {
      data: fixture('tiny-40x20.png'),
      rawFilename: '"say \\"cheese\\".png"',
    });
    await expectContract(res, 'uploadMyAvatar');
    expect(res.status, res.text).toBe(200);
    expect(res.body.originalName).toBe('say "cheese".png');
    const file = await download(api(), apiPath(res.body.url));
    expect(file.headers.get('content-disposition')).toBe(
      `inline; filename="say _cheese_.webp"; filename*=UTF-8''say%20%22cheese%22.webp`,
    );
  });

  it('P17: the stored name is the base name — `/` and `\\` path segments are dropped', async () => {
    const { client } = await freshHead('FARM');
    for (const [raw, expected] of [
      ['"reports/2026/photo.png"', 'photo.png'],
      ['"C:\\\\fakepath\\\\Фото.png"', 'Фото.png'],
    ]) {
      const res = await upload(client, '/me/avatar', { data: fixture('tiny-40x20.png'), rawFilename: raw });
      await expectContract(res, 'uploadMyAvatar');
      expect(res.body.originalName, raw).toBe(expected);
    }
  });
});

describe('downloadPublicFile', () => {
  it('logos and product photos without authorization: public caching, ETag, 304, variant', async () => {
    const lab = await loginAs('LAB');
    const logoId = fileIdOf((await lab.get('/me')).body.organization.logoUrl);
    const res = await api().get(`/public/files/${logoId}`);
    await expectContract(res, 'downloadPublicFile');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(PUBLIC);
    const etag = res.headers.get('etag')!;
    expect(etag).toBe(`"${sha256hex(res.bytes)}"`);
    const cached = await api().get(`/public/files/${logoId}`, { headers: { 'if-none-match': etag } });
    await expectContract(cached, 'downloadPublicFile');
    expect(cached.status).toBe(304);
    expect(cached.headers.get('cache-control')).toBe(PUBLIC);

    const product = await productPhoto(lab);
    const photo = await api().get(`/public/files/${product!.id}`, { query: { variant: 96 } });
    await expectContract(photo, 'downloadPublicFile');
    expect(photo.contentType).toBe('image/webp');
    expect(Math.max(...Object.values(webpSize(photo.bytes)))).toBe(96);
  });

  it('an avatar (or any non-public file) is not served here → 404; unknown → 404; malformed → 400', async () => {
    const { fileId } = await withAvatar();
    const res = await api().get(`/public/files/${fileId}`);
    await expectContract(res, 'downloadPublicFile');
    expectProblem(res, 404, 'NOT_FOUND');
    // TODO(Task 9): the lab protocol id from the lab API once it exists.
    const [protocol] = await query<{ id: string }>(
      `SELECT id FROM files WHERE kind = 'LAB_PROTOCOL' LIMIT 1`,
    );
    for (const id of [protocol!.id, UUID0]) {
      const missing = await api().get(`/public/files/${id}`);
      await expectContract(missing, 'downloadPublicFile');
      expectProblem(missing, 404, 'NOT_FOUND');
    }
    const bad = await api().get('/public/files/nope');
    await expectContract(bad, 'downloadPublicFile');
    expectErrors(bad, { id: ['validation.uuid'] });
  });
});
