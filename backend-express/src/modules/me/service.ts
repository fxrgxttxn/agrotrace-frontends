/**
 * Profile operations (contracts/openapi/paths/me.yaml): FR-IAM-07 (name, phone, avatar), FR-NOTIF-02/03 (channels,
 * Telegram link code). Transactions touch only the database; MinIO objects are written before the row that points at
 * them, Redis after (P8).
 */
import { randomInt } from 'node:crypto';
import { ChannelsUpdateSchema, MeUpdateSchema } from '@agrotrace/validation';
import type { Container } from '../../container.js';
import { withTx } from '../../db/tx.js';
import { AppProblem, validationProblem } from '../../http/problem.js';
import type { UploadedFile } from '../../http/multipart.js';
import { RASTER_TYPES } from '../../infra/images.js';
import type { Principal } from '../../security/jwt.js';
import { auditDiff, auditService } from '../audit/service.js';
import {
  fileAuditView,
  fileRef,
  insertFile,
  prepareUpload,
  softDeleteFile,
  storeObjects,
  type FileRef,
} from '../files/service.js';
import { loadMe, type MeView } from './view.js';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const TGCODE_TTL_SEC = 600;
const TGCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * R82/R90: `tgcode:{code}` = {"userId"} (NX — a code is never shared) and `tgcode-user:{userId}` = code, both 600 s;
 * the previous code of the user is deleted in the same script, so at most one code per user is ever live.
 * Returns 0 when the new code collides with a live one (the caller draws another).
 */
const TGCODE_SCRIPT = `
local previous = redis.call('GET', KEYS[2])
if not redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3], 'NX') then return 0 end
if previous and previous ~= ARGV[2] then redis.call('DEL', 'tgcode:' .. previous) end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1`;

export interface Channels {
  email: boolean;
  telegram: boolean;
  telegramLinked: boolean;
}

export function meService(c: Container) {
  const { db } = c;

  async function me(userId: string): Promise<MeView> {
    const view = await loadMe(db, c.fileUrls, userId);
    // A deleted account's token lives out its 15 minutes: it no longer identifies a user.
    if (!view) throw new AppProblem(401, 'UNAUTHORIZED');
    return view;
  }

  async function channelsOf(userId: string): Promise<Channels> {
    return (await me(userId)).channels;
  }

  return {
    getMe: (p: Principal) => me(p.userId),

    /** updateMe — fullName and phone only (never trimmed, R36); `phone: null` removes the phone. */
    async updateMe(p: Principal, body: unknown): Promise<MeView> {
      const input = MeUpdateSchema.parse(body);
      await withTx(db, async (tx) => {
        const u = await tx
          .selectFrom('users')
          .select(['full_name', 'phone'])
          .where('id', '=', p.userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!u) throw new AppProblem(401, 'UNAUTHORIZED');
        const before = { fullName: u.full_name, phone: u.phone };
        const after = {
          fullName: input.fullName ?? u.full_name,
          phone: input.phone === undefined ? u.phone : input.phone,
        };
        const diff = auditDiff(before, after);
        if (Object.keys(diff).length === 0) return;
        await tx
          .updateTable('users')
          .set({ full_name: after.fullName, phone: after.phone, updated_at: new Date() })
          .where('id', '=', p.userId)
          .execute();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'updateMe',
          entityType: 'user',
          entityId: p.userId,
          diff,
        });
      });
      return me(p.userId);
    },

    /** uploadMyAvatar — JPEG/PNG/WebP ≤ 2 MiB → WebP 96/480; the previous avatar file is soft-deleted. */
    async uploadAvatar(p: Principal, upload: UploadedFile): Promise<FileRef> {
      const file = await prepareUpload(upload, {
        kind: 'AVATAR',
        ownerId: p.userId,
        bucket: c.s3.bucket,
        allowed: RASTER_TYPES,
      });
      await storeObjects(c.s3, file);
      await withTx(db, async (tx) => {
        const u = await tx
          .selectFrom('users')
          .select('avatar_file_id')
          .where('id', '=', p.userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!u) throw new AppProblem(401, 'UNAUTHORIZED');
        const now = new Date();
        await insertFile(tx, file);
        await tx
          .updateTable('users')
          .set({ avatar_file_id: file.row.id, updated_at: now })
          .where('id', '=', p.userId)
          .execute();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'uploadMyAvatar',
          entityType: 'file',
          entityId: file.row.id,
          diff: auditDiff(null, fileAuditView(file.row)),
        });
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'uploadMyAvatar',
          entityType: 'user',
          entityId: p.userId,
          diff: { avatarFileId: [u.avatar_file_id, file.row.id] },
        });
        if (await softDeleteFile(tx, u.avatar_file_id, now))
          await auditService.record(tx, {
            actorId: p.userId,
            action: 'uploadMyAvatar',
            entityType: 'file',
            entityId: u.avatar_file_id,
            diff: { deletedAt: [null, now.toISOString()] },
          });
      });
      return fileRef(c.fileUrls, {
        id: file.row.id,
        kind: 'AVATAR',
        mime: file.row.mime,
        size_bytes: String(file.row.size_bytes),
        original_name: file.row.original_name,
      });
    },

    /** deleteMyAvatar — idempotent: 204 whether or not there was an avatar. */
    async deleteAvatar(p: Principal): Promise<void> {
      await withTx(db, async (tx) => {
        const u = await tx
          .selectFrom('users')
          .select('avatar_file_id')
          .where('id', '=', p.userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!u || u.avatar_file_id === null) return;
        const now = new Date();
        await tx
          .updateTable('users')
          .set({ avatar_file_id: null, updated_at: now })
          .where('id', '=', p.userId)
          .execute();
        await softDeleteFile(tx, u.avatar_file_id, now);
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'deleteMyAvatar',
          entityType: 'user',
          entityId: p.userId,
          diff: { avatarFileId: [u.avatar_file_id, null] },
        });
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'deleteMyAvatar',
          entityType: 'file',
          entityId: u.avatar_file_id,
          diff: { deletedAt: [null, now.toISOString()] },
        });
      });
    },

    getChannels: (p: Principal) => channelsOf(p.userId),

    /** updateMyChannels — `telegram: true` needs a linked Telegram (400 validation.telegram.notLinked). */
    async updateChannels(p: Principal, body: unknown): Promise<Channels> {
      const input = ChannelsUpdateSchema.parse(body);
      await withTx(db, async (tx) => {
        const u = await tx
          .selectFrom('users')
          .select(['notification_channels', 'telegram_chat_id'])
          .where('id', '=', p.userId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!u) throw new AppProblem(401, 'UNAUTHORIZED');
        if (input.telegram && u.telegram_chat_id === null)
          throw validationProblem({ telegram: ['validation.telegram.notLinked'] });
        const stored = (u.notification_channels ?? {}) as { email?: boolean; telegram?: boolean };
        const before = { email: stored.email === true, telegram: stored.telegram === true };
        const after = { email: input.email, telegram: input.telegram };
        if (before.email === after.email && before.telegram === after.telegram) return;
        await tx
          .updateTable('users')
          .set({ notification_channels: JSON.stringify(after), updated_at: new Date() })
          .where('id', '=', p.userId)
          .execute();
        await auditService.record(tx, {
          actorId: p.userId,
          action: 'updateMyChannels',
          entityType: 'user',
          entityId: p.userId,
          diff: { channels: [before, after] },
        });
      });
      return channelsOf(p.userId);
    },

    /** createTelegramCode — 8 characters [A-Z0-9], 10 minutes; a new code cancels the previous one (R82/R90). */
    async createTelegramCode(
      p: Principal,
    ): Promise<{ code: string; expiresAt: string; botUsername: string }> {
      if (!c.config.TELEGRAM_BOT_TOKEN)
        throw new AppProblem(503, 'EXTERNAL_UNAVAILABLE', { params: { service: 'telegram' } });
      await me(p.userId);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = Array.from({ length: 8 }, () => TGCODE_ALPHABET[randomInt(TGCODE_ALPHABET.length)]).join(
          '',
        );
        const issued = Date.now();
        const ok = await c.redis.eval(
          TGCODE_SCRIPT,
          2,
          `tgcode:${code}`,
          `tgcode-user:${p.userId}`,
          JSON.stringify({ userId: p.userId }),
          code,
          String(TGCODE_TTL_SEC),
        );
        if (Number(ok) === 1)
          return {
            code,
            expiresAt: new Date(Math.floor(issued / 1000) * 1000 + TGCODE_TTL_SEC * 1000)
              .toISOString()
              .replace('.000Z', 'Z'),
            botUsername: c.config.TELEGRAM_BOT_USERNAME,
          };
      }
      throw new Error('createTelegramCode: could not draw a free code');
    },
  };
}

export type MeService = ReturnType<typeof meService>;
