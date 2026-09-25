/**
 * The contract's `Me` (users.yaml#/Me): the signed-in user as login/verify return it (and GET /me, Task 3). Avatar —
 * a signed URL (R28), organization logo — a public URL.
 */
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.generated.js';
import { publicFileUrl, type FileUrls } from '../../infra/file-urls.js';
import type { RoleCode } from '../../security/jwt.js';

export interface MeView {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  avatarUrl: string | null;
  roles: RoleCode[];
  organization: { id: string; name: string; type: string; logoUrl: string | null };
  isOrgAdmin: boolean;
  totpEnabled: boolean;
  channels: { email: boolean; telegram: boolean; telegramLinked: boolean };
}

/** Role codes of a user in the stable order of the `roles` dictionary. */
export async function userRoles(db: Kysely<DB>, userId: string): Promise<RoleCode[]> {
  const rows = await db
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', 'r.id', 'ur.role_id')
    .select('r.code')
    .where('ur.user_id', '=', userId)
    .orderBy('r.id')
    .execute();
  return rows.map((r) => r.code as RoleCode);
}

export async function loadMe(db: Kysely<DB>, fileUrls: FileUrls, userId: string): Promise<MeView | null> {
  const u = await db
    .selectFrom('users as u')
    .innerJoin('organizations as o', 'o.id', 'u.organization_id')
    .select([
      'u.id',
      'u.email',
      'u.full_name',
      'u.phone',
      'u.avatar_file_id',
      'u.is_org_admin',
      'u.totp_enabled',
      'u.notification_channels',
      'u.telegram_chat_id',
      'o.id as org_id',
      'o.name as org_name',
      'o.type as org_type',
      'o.logo_file_id',
    ])
    .where('u.id', '=', userId)
    .where('u.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!u) return null;
  const channels = (u.notification_channels ?? {}) as { email?: boolean; telegram?: boolean };
  return {
    id: u.id,
    email: u.email.toLowerCase(),
    fullName: u.full_name,
    phone: u.phone,
    avatarUrl: u.avatar_file_id ? fileUrls.signed(u.avatar_file_id) : null,
    roles: await userRoles(db, u.id),
    organization: {
      id: u.org_id,
      name: u.org_name,
      type: u.org_type,
      logoUrl: u.logo_file_id ? publicFileUrl(u.logo_file_id) : null,
    },
    isOrgAdmin: u.is_org_admin,
    totpEnabled: u.totp_enabled,
    channels: {
      email: channels.email === true,
      telegram: channels.telegram === true,
      telegramLinked: u.telegram_chat_id !== null,
    },
  };
}
