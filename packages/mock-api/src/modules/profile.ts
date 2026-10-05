import { ChannelsUpdateSchema, MeUpdateSchema } from '@agrotrace/validation';
import { parseBody } from '../http/body.js';
import { json, noContent, type Ctx, type Handler } from '../http/context.js';
import { ApiError, validation } from '../http/problem.js';
import { fileRef, insertBytesFile, softDeleteFile } from '../domain/files.js';
import { RASTER_TYPES, readUpload } from '../domain/uploads.js';
import { randomBytes } from '../lib/crypto.js';
import { iso } from '../lib/time.js';
import type { UserRow } from '../store/types.js';
import { channelsView, meView } from '../views/users.js';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const TGCODE_TTL_SEC = 600;
const TGCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function me(ctx: Ctx): UserRow {
  const u = ctx.store.get('users', ctx.user().userId);
  if (!u || u.deleted_at !== null) throw new ApiError(401, 'UNAUTHORIZED');
  return u;
}

export const profileHandlers: Record<string, Handler> = {
  getMe: (ctx) => json(200, meView(ctx, me(ctx))),

  async updateMe(ctx) {
    const input = parseBody(MeUpdateSchema, await ctx.json());
    const u = me(ctx);
    ctx.store.touch('user', u);
    const changes: Partial<UserRow> = {};
    if (input.fullName !== undefined) changes.full_name = input.fullName;
    if (input.phone !== undefined) changes.phone = input.phone;
    if (Object.entries(changes).some(([k, v]) => u[k as keyof UserRow] !== v))
      ctx.store.patch(u, { ...changes, updated_at: ctx.store.nowIso() });
    return json(200, meView(ctx, u));
  },

  async uploadMyAvatar(ctx) {
    const u = me(ctx);
    const up = await readUpload(ctx, AVATAR_MAX_BYTES, RASTER_TYPES);
    const variants = up.variants;
    const file = insertBytesFile(ctx.store, {
      kind: 'AVATAR',
      originalName: up.name,
      mime: up.mime,
      data: up.bytes,
      ownerId: u.id,
      ...(variants && { variants }),
    });
    const old = u.avatar_file_id;
    ctx.store.touch('user', u);
    ctx.store.patch(u, { avatar_file_id: file.id, updated_at: ctx.store.nowIso() });
    softDeleteFile(ctx.store, old);
    return json(200, fileRef(ctx.cfg, file));
  },

  deleteMyAvatar(ctx) {
    const u = me(ctx);
    if (u.avatar_file_id !== null) {
      const old = u.avatar_file_id;
      ctx.store.touch('user', u);
      ctx.store.patch(u, { avatar_file_id: null, updated_at: ctx.store.nowIso() });
      softDeleteFile(ctx.store, old);
    }
    return noContent();
  },

  getMyChannels: (ctx) => json(200, channelsView(me(ctx))),

  async updateMyChannels(ctx) {
    const input = parseBody(ChannelsUpdateSchema, await ctx.json());
    const u = me(ctx);
    if (input.telegram && u.telegram_chat_id === null) throw validation({ telegram: ['validation.telegram.notLinked'] });
    const before = u.notification_channels;
    if (before.email !== input.email || before.telegram !== input.telegram) {
      ctx.store.audit({ entityType: 'user', entityId: u.id, diff: { channels: [before, { ...input }] } });
      ctx.store.patch(u, { notification_channels: { email: input.email, telegram: input.telegram }, updated_at: ctx.store.nowIso() });
    }
    return json(200, channelsView(u));
  },

  createTelegramCode(ctx) {
    if (!ctx.cfg.telegramBot) throw new ApiError(503, 'EXTERNAL_UNAVAILABLE', { params: { service: 'telegram' } });
    const u = me(ctx);
    let code = '';
    do code = Array.from(randomBytes(8), (b) => TGCODE_ALPHABET[b % TGCODE_ALPHABET.length]).join('');
    while (ctx.store.kvGet(`tgcode:${code}`) !== undefined);
    const previous = ctx.store.kvGet<string>(`tgcode-user:${u.id}`);
    if (previous) ctx.store.kvDel(`tgcode:${previous}`);
    ctx.store.kvSet(`tgcode:${code}`, { userId: u.id }, TGCODE_TTL_SEC);
    ctx.store.kvSet(`tgcode-user:${u.id}`, code, TGCODE_TTL_SEC);
    const issued = Math.floor(ctx.store.now() / 1000) * 1000;
    return json(201, { code, expiresAt: iso(issued + TGCODE_TTL_SEC * 1000), botUsername: ctx.cfg.telegramBot });
  },
};
