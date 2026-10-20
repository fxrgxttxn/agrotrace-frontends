/** The contract's `User` (users.yaml#/User) for a set of users: signed avatar URL, organization ref with public logo. */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../db/types.generated.js';
import { publicFileUrl, type FileUrls } from '../../infra/file-urls.js';
import type { RoleCode } from '../../security/jwt.js';

export interface UserView {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  avatarUrl: string | null;
  roles: RoleCode[];
  isOrgAdmin: boolean;
  status: 'INVITED' | 'ACTIVE' | 'BLOCKED';
  organization: { id: string; name: string; type: string; logoUrl: string | null };
}

/** Views of `ids` in the order given (missing ids are skipped). */
export async function loadUserViews(
  db: Kysely<DB> | Transaction<DB>,
  fileUrls: FileUrls,
  ids: string[],
): Promise<UserView[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('users as u')
    .innerJoin('organizations as o', 'o.id', 'u.organization_id')
    .select([
      'u.id',
      'u.email',
      'u.full_name',
      'u.phone',
      'u.avatar_file_id',
      'u.is_org_admin',
      'u.status',
      'o.id as org_id',
      'o.name as org_name',
      'o.type as org_type',
      'o.logo_file_id',
      // Role codes in the stable order of the `roles` dictionary.
      sql<RoleCode[]>`ARRAY(SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                             WHERE ur.user_id = u.id ORDER BY r.id)`.as('roles'),
    ])
    .where('u.id', 'in', ids)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const u = byId.get(id);
    if (!u) return [];
    return [
      {
        id: u.id,
        email: u.email.toLowerCase(),
        fullName: u.full_name,
        phone: u.phone,
        avatarUrl: u.avatar_file_id ? fileUrls.signed(u.avatar_file_id) : null,
        roles: u.roles,
        isOrgAdmin: u.is_org_admin,
        status: u.status as UserView['status'],
        organization: {
          id: u.org_id,
          name: u.org_name,
          type: u.org_type,
          logoUrl: u.logo_file_id ? publicFileUrl(u.logo_file_id) : null,
        },
      },
    ];
  });
}
