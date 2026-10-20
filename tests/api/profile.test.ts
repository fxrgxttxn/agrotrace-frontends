/**
 * Profile (contracts/openapi/paths/me.yaml): getMe, updateMe, the avatar (uploadMyAvatar / deleteMyAvatar — formats by
 * signature, the inclusive 2 MiB limit, WebP 96/480 variants, replacement soft-deletes the old file), notification
 * channels and the Telegram link code (R82/R90 keys `tgcode:{code}`, `tgcode-user:{userId}`).
 *
 * Suites that change data work on fresh organizations (lib/fixtures.ts); demo users are only read.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { demoUser, loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { API_BACKEND } from './lib/env.js';
import { auditEntries } from './lib/audit.js';
import { closeDb, fixtureWrite } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import {
  apiPath,
  fileIdOf,
  fixture,
  MAX_IMAGE_BYTES,
  pngOfSize,
  RASTER,
  sha256hex,
  upload,
  webpSize,
} from './lib/files.js';
import { freshHead } from './lib/fixtures.js';
import { closeRedis, redis } from './lib/redis.js';
import { DEMO_PASSWORD } from '../../db/seed/src/data.js';

afterAll(async () => {
  await Promise.all([closeDb(), closeRedis()]);
});

const ROLES: Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const SIGNED_URL = /^\/api\/v1\/files\/[0-9a-f-]{36}\?exp=\d{10}&sig=[0-9a-f]{64}$/;

async function uploadAvatar(
  client: ApiClient,
  file: { data: Buffer | string; filename?: string; contentType?: string },
) {
  const res = await upload(client, '/me/avatar', file);
  await expectContract(res, 'uploadMyAvatar');
  return res;
}

async function getMe(client: ApiClient) {
  const res = await client.get('/me');
  await expectContract(res, 'getMe');
  expect(res.status, res.text).toBe(200);
  return res.body;
}

/** Downloads a signed URL without Authorization (as an <img src> would). */
async function fetchSigned(url: string, variant?: 96 | 480) {
  const res = await api().get(apiPath(url), variant ? { query: { variant } } : {});
  await expectContract(res, 'downloadFile');
  return res;
}

/** The audit rows of `action` on one entity (listAuditLog), oldest first. */
const auditRows = async (action: string, entityId: string) =>
  (await auditEntries({ action, entityId })).map((r) => ({
    entity_type: r.entityType,
    diff: r.diff,
    backend: r.backend,
    actor_id: r.actor?.id ?? null,
  }));

describe('x-roles ANY: every role reaches the profile; no token → 401', () => {
  it.each(ROLES)('%s: getMe, getMyChannels', async (role) => {
    const client = await loginAs(role);
    const me = await getMe(client);
    expect(me.email).toBe(demoUser(role).email);
    expect(me.roles).toContain(role);
    const channels = await client.get('/me/channels');
    await expectContract(channels, 'getMyChannels');
    expect(channels.status).toBe(200);
  });

  it('every profile operation without a token → 401 UNAUTHORIZED', async () => {
    const anon = api();
    const calls: [string, Promise<Awaited<ReturnType<ApiClient['get']>>>][] = [
      ['getMe', anon.get('/me')],
      ['updateMe', anon.patch('/me', { fullName: 'X' })],
      ['uploadMyAvatar', uploadAvatar(anon, { data: fixture('tiny-40x20.png') })],
      ['deleteMyAvatar', anon.delete('/me/avatar')],
      ['getMyChannels', anon.get('/me/channels')],
      ['updateMyChannels', anon.put('/me/channels', { email: true, telegram: false })],
      ['createTelegramCode', anon.post('/me/telegram-code')],
    ];
    for (const [op, pending] of calls) {
      const res = await pending;
      await expectContract(res, op);
      expectProblem(res, 401, 'UNAUTHORIZED');
    }
  });
});

describe('getMe', () => {
  it('is the Me of the signed-in user (same as the login response); avatar signed, logo public', async () => {
    const u = demoUser('FARMER', { key: 'zarya.head' });
    const client = api();
    const login = await client.post('/auth/login', { email: u.email, password: DEMO_PASSWORD });
    expect(login.status, login.text).toBe(200);
    client.accessToken = login.body.accessToken;
    const me = await getMe(client);
    const { avatarUrl: loginAvatar, ...loginRest } = login.body.user;
    const { avatarUrl, ...rest } = me;
    expect(rest).toEqual(loginRest);
    expect(fileIdOf(avatarUrl)).toBe(fileIdOf(loginAvatar));
    expect(me).toMatchObject({ email: u.email, fullName: u.fullName, roles: ['FARMER'], isOrgAdmin: true });
    expect(me.avatarUrl).toMatch(SIGNED_URL); // zarya.head has a seeded avatar
    expect(me.organization.logoUrl).toMatch(/^\/api\/v1\/public\/files\/[0-9a-f-]{36}$/);
  });
});

describe('updateMe', () => {
  it('changes fullName and phone (never trimmed); phone null removes it; audit row with the diff', async () => {
    const { client, user } = await freshHead('FARM');
    const res = await client.patch('/me', { fullName: '  Иванов Иван  ', phone: '+79181234567' });
    await expectContract(res, 'updateMe');
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ fullName: '  Иванов Иван  ', phone: '+79181234567' });
    expect((await getMe(client)).fullName).toBe('  Иванов Иван  ');

    const cleared = await client.patch('/me', { phone: null });
    await expectContract(cleared, 'updateMe');
    expect(cleared.body.phone).toBeNull();
    expect(cleared.body.fullName).toBe('  Иванов Иван  ');

    const audit = await auditRows('updateMe', user.id);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ entity_type: 'user', backend: API_BACKEND, actor_id: user.id });
    expect(audit[0]!.diff).toEqual({
      fullName: ['Тестов Тест Тестович', '  Иванов Иван  '],
      phone: [null, '+79181234567'],
    });
    expect(audit[1]!.diff).toEqual({ phone: ['+79181234567', null] });
  });

  it('invalid bodies → 400 VALIDATION with field errors; email and roles cannot be changed here', async () => {
    const { client } = await freshHead('FARM');
    const cases: [unknown, Record<string, string[]>][] = [
      [{}, { _root: ['validation.minProperties'] }],
      [{ fullName: '   ' }, { fullName: ['validation.pattern'] }],
      [{ fullName: '' }, { fullName: ['validation.required'] }],
      [{ phone: '89181234567' }, { phone: ['validation.phone.format'] }],
      [{ fullName: 'Иванов', email: 'x@y.ru' }, { email: ['validation.unknownField'] }],
      [{ phone: null, roles: ['ADMIN'] }, { roles: ['validation.unknownField'] }],
      [[], { _root: ['validation.type'] }],
    ];
    for (const [body, errors] of cases) {
      const res = await client.patch('/me', body);
      await expectContract(res, 'updateMe');
      expectErrors(res, errors);
    }
  });
});

describe('notification channels', () => {
  it('default {email: true, telegram: false}; update; telegram: true without a link → 400 notLinked', async () => {
    const { client, user } = await freshHead('FARM');
    const initial = await client.get('/me/channels');
    await expectContract(initial, 'getMyChannels');
    expect(initial.body).toEqual({ email: true, telegram: false, telegramLinked: false });

    const off = await client.put('/me/channels', { email: false, telegram: false });
    await expectContract(off, 'updateMyChannels');
    expect(off.status, off.text).toBe(200);
    expect(off.body).toEqual({ email: false, telegram: false, telegramLinked: false });
    expect((await getMe(client)).channels).toEqual(off.body);

    const unlinked = await client.put('/me/channels', { email: true, telegram: true });
    await expectContract(unlinked, 'updateMyChannels');
    expectErrors(unlinked, { telegram: ['validation.telegram.notLinked'] });

    // Linking happens through the Telegram poller (Task 12): the chat id is set as a fixture until then.
    await fixtureWrite(`UPDATE users SET telegram_chat_id = 424242 WHERE id = $1`, [user.id]);
    const linked = await client.put('/me/channels', { email: true, telegram: true });
    await expectContract(linked, 'updateMyChannels');
    expect(linked.body).toEqual({ email: true, telegram: true, telegramLinked: true });

    const audit = await auditRows('updateMyChannels', user.id);
    expect(audit.map((a) => a.diff)).toEqual([
      {
        channels: [
          { email: true, telegram: false },
          { email: false, telegram: false },
        ],
      },
      {
        channels: [
          { email: false, telegram: false },
          { email: true, telegram: true },
        ],
      },
    ]);
  });

  it('invalid body → 400 (both fields required, booleans only)', async () => {
    const { client } = await freshHead('FARM');
    for (const [body, errors] of [
      [{ email: true }, { telegram: ['validation.required'] }],
      [{ email: 'yes', telegram: false }, { email: ['validation.type'] }],
      [{ email: true, telegram: false, sms: true }, { sms: ['validation.unknownField'] }],
    ] as const) {
      const res = await client.put('/me/channels', body);
      await expectContract(res, 'updateMyChannels');
      expectErrors(res, errors);
    }
  });
});

describe('createTelegramCode', () => {
  it('201 code/expiresAt/botUsername; tgcode:{code} = {"userId"} (600 s); a new code cancels the previous one', async () => {
    const { client, user } = await freshHead('FARM');
    const before = Date.now();
    const first = await client.post('/me/telegram-code');
    await expectContract(first, 'createTelegramCode');
    expect(first.status, first.text).toBe(201);
    expect(first.body.code).toMatch(/^[A-Z0-9]{8}$/);
    const expiresAt = Date.parse(first.body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 599_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 601_000);

    const r = redis();
    expect(JSON.parse((await r.get(`tgcode:${first.body.code}`))!)).toEqual({ userId: user.id });
    expect(await r.ttl(`tgcode:${first.body.code}`)).toBeGreaterThan(590);
    expect(await r.get(`tgcode-user:${user.id}`)).toBe(first.body.code);

    const second = await client.post('/me/telegram-code');
    await expectContract(second, 'createTelegramCode');
    expect(second.status).toBe(201);
    expect(second.body.code).not.toBe(first.body.code);
    expect(await r.exists(`tgcode:${first.body.code}`)).toBe(0);
    expect(JSON.parse((await r.get(`tgcode:${second.body.code}`))!)).toEqual({ userId: user.id });
    expect(await r.get(`tgcode-user:${user.id}`)).toBe(second.body.code);
  });
});

// ── avatar ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('uploadMyAvatar', () => {
  it('PNG → FileRef (signed URL, original MIME/size/name); WebP 480 by default and 96 on request', async () => {
    const { client, user } = await freshHead('FARM');
    const png = fixture('landscape-640x320.png');
    const res = await uploadAvatar(client, { data: png, filename: 'Моё фото.png', contentType: 'image/png' });
    await expectContract(res, 'uploadMyAvatar');
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      mime: 'image/png',
      sizeBytes: png.length,
      originalName: 'Моё фото.png',
    });
    expect(res.body.url).toMatch(SIGNED_URL);
    expect(fileIdOf(res.body.url)).toBe(res.body.id);

    const me = await getMe(client);
    expect(fileIdOf(me.avatarUrl)).toBe(res.body.id);

    const big = await fetchSigned(res.body.url);
    expect(big.status).toBe(200);
    expect(big.contentType).toBe('image/webp');
    expect(webpSize(big.bytes)).toEqual({ width: 480, height: 240 });
    const small = await fetchSigned(res.body.url, 96);
    expect(webpSize(small.bytes)).toEqual({ width: 96, height: 48 });
    expect(small.headers.get('etag')).toBe(`"${sha256hex(small.bytes)}"`);

    const audit = (await auditEntries({ action: 'uploadMyAvatar', actorId: user.id })).map((r) => ({
      entity_type: r.entityType,
      entity_id: r.entityId,
      diff: r.diff,
    }));
    expect(audit.map((a) => a.entity_type).sort()).toEqual(['file', 'user']);
    const userRow = audit.find((a) => a.entity_type === 'user')!;
    expect(userRow.entity_id).toBe(user.id);
    expect(userRow.diff).toEqual({ avatarFileId: [null, res.body.id] });
    const fileRow = audit.find((a) => a.entity_type === 'file')!;
    expect(fileRow.entity_id).toBe(res.body.id);
    expect(fileRow.diff).toMatchObject({
      kind: [null, 'AVATAR'],
      mime: [null, 'image/png'],
      sizeBytes: [null, png.length],
      originalName: [null, 'Моё фото.png'],
    });
  });

  it('JPEG (portrait) and WebP (with alpha) are accepted; an image smaller than 96 px is not enlarged', async () => {
    const { client } = await freshHead('FARM');
    const jpeg = await uploadAvatar(client, { data: fixture('portrait-300x600.jpg'), filename: 'a.jpg' });
    await expectContract(jpeg, 'uploadMyAvatar');
    expect(jpeg.body.mime).toBe('image/jpeg');
    expect(webpSize((await fetchSigned(jpeg.body.url)).bytes)).toEqual({ width: 240, height: 480 });
    expect(webpSize((await fetchSigned(jpeg.body.url, 96)).bytes)).toEqual({ width: 48, height: 96 });

    const webp = await uploadAvatar(client, { data: fixture('alpha-200x100.webp'), filename: 'a.webp' });
    await expectContract(webp, 'uploadMyAvatar');
    expect(webp.body.mime).toBe('image/webp');
    expect(webpSize((await fetchSigned(webp.body.url)).bytes)).toEqual({ width: 200, height: 100 });
    expect(webpSize((await fetchSigned(webp.body.url, 96)).bytes)).toEqual({ width: 96, height: 48 });

    const tiny = await uploadAvatar(client, { data: fixture('tiny-40x20.png'), filename: 'tiny.png' });
    expect(webpSize((await fetchSigned(tiny.body.url, 96)).bytes)).toEqual({ width: 40, height: 20 });
    expect(webpSize((await fetchSigned(tiny.body.url, 480)).bytes)).toEqual({ width: 40, height: 20 });
  });

  it('the type is taken from the signature: a PNG named .jpg with Content-Type image/jpeg is stored as PNG', async () => {
    const { client } = await freshHead('FARM');
    const res = await uploadAvatar(client, {
      data: fixture('landscape-640x320.png'),
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });
    await expectContract(res, 'uploadMyAvatar');
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ mime: 'image/png', originalName: 'photo.jpg' });
  });

  it('a type outside JPEG/PNG/WebP by signature → 415 {allowed}, whatever the name and Content-Type say', async () => {
    const { client } = await freshHead('FARM');
    for (const [name, filename, contentType] of [
      ['text-as-image.png', 'photo.png', 'image/png'],
      ['fake-signature.png', 'photo.png', 'image/png'],
      ['logo-clean.svg', 'logo.svg', 'image/svg+xml'],
      ['document.pdf', 'photo.jpg', 'image/jpeg'],
    ]) {
      const res = await uploadAvatar(client, { data: fixture(name!), filename, contentType });
      await expectContract(res, 'uploadMyAvatar');
      expectProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE', { allowed: RASTER });
    }
    expect((await getMe(client)).avatarUrl).toBeNull();
  });

  it('Review Focus #5: exactly 2 097 152 bytes is accepted, one byte more → 413 FILE_TOO_LARGE {maxBytes}', async () => {
    const { client } = await freshHead('FARM');
    const exact = pngOfSize(MAX_IMAGE_BYTES);
    const ok = await uploadAvatar(client, { data: exact, filename: 'exact.png' });
    await expectContract(ok, 'uploadMyAvatar');
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.sizeBytes).toBe(MAX_IMAGE_BYTES);

    const over = await uploadAvatar(client, { data: pngOfSize(MAX_IMAGE_BYTES + 1), filename: 'over.png' });
    await expectContract(over, 'uploadMyAvatar');
    expectProblem(over, 413, 'FILE_TOO_LARGE', { maxBytes: MAX_IMAGE_BYTES });
    // The avatar is still the accepted one.
    expect(fileIdOf((await getMe(client)).avatarUrl)).toBe(ok.body.id);
  });

  it('malformed multipart bodies → 400 VALIDATION', async () => {
    const { client } = await freshHead('FARM');
    const png = fixture('tiny-40x20.png');
    const noFile = await client.put('/me/avatar', { file: 'x' });
    await expectContract(noFile, 'uploadMyAvatar');
    expectErrors(noFile, { file: ['validation.required'] });

    const extra = await upload(client, '/me/avatar', { data: png, filename: 'a.png' }, [
      { name: 'caption', data: 'hello' },
    ]);
    await expectContract(extra, 'uploadMyAvatar');
    expectErrors(extra, { caption: ['validation.unknownField'] });

    const wrongField = await upload(client, '/me/avatar', { data: png, filename: 'a.png' }, [
      { name: 'image', filename: 'b.png', contentType: 'image/png', data: png },
    ]);
    await expectContract(wrongField, 'uploadMyAvatar');
    expectErrors(wrongField, { image: ['validation.unknownField'] });

    const twice = await upload(client, '/me/avatar', { data: png, filename: 'a.png' }, [
      { name: 'file', filename: 'b.png', contentType: 'image/png', data: png },
    ]);
    await expectContract(twice, 'uploadMyAvatar');
    expectErrors(twice, { file: ['validation.duplicate'] });

    const empty = await upload(client, '/me/avatar', { data: Buffer.alloc(0), filename: 'a.png' });
    await expectContract(empty, 'uploadMyAvatar');
    expectErrors(empty, { file: ['validation.required'] });
    expect((await getMe(client)).avatarUrl).toBeNull();
  });

  it('replacing soft-deletes the previous file: its signed URL → 404, the new one works', async () => {
    const { client } = await freshHead('FARM');
    const first = await uploadAvatar(client, { data: fixture('tiny-40x20.png'), filename: 'one.png' });
    expect((await fetchSigned(first.body.url)).status).toBe(200);
    const second = await uploadAvatar(client, { data: fixture('portrait-300x600.jpg'), filename: 'two.jpg' });
    expect(second.status).toBe(200);
    expect(second.body.id).not.toBe(first.body.id);
    const gone = await fetchSigned(first.body.url);
    expectProblem(gone, 404, 'NOT_FOUND');
    expect((await fetchSigned(second.body.url)).status).toBe(200);
    // The replaced file's soft delete is in the audit log of the second upload.
    const deletion = (await auditEntries({ action: 'uploadMyAvatar', entityId: first.body.id })).filter(
      (r) => r.diff.deletedAt,
    );
    expect(deletion).toHaveLength(1);
    expect(deletion[0]!.diff.deletedAt![0]).toBeNull();
    expect(deletion[0]!.diff.deletedAt![1]).toEqual(expect.any(String));
  });
});

describe('deleteMyAvatar', () => {
  it('204, avatarUrl null, the file URL → 404; idempotent (204 without an avatar)', async () => {
    const { client, user } = await freshHead('FARM');
    const up = await uploadAvatar(client, { data: fixture('tiny-40x20.png'), filename: 'a.png' });
    const del = await client.delete('/me/avatar');
    await expectContract(del, 'deleteMyAvatar');
    expect(del.status, del.text).toBe(204);
    expect((await getMe(client)).avatarUrl).toBeNull();
    expectProblem(await fetchSigned(up.body.url), 404, 'NOT_FOUND');

    const again = await client.delete('/me/avatar');
    await expectContract(again, 'deleteMyAvatar');
    expect(again.status).toBe(204);

    const audit = await auditRows('deleteMyAvatar', user.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.diff).toEqual({ avatarFileId: [up.body.id, null] });
  });
});
