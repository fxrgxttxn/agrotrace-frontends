import type { Mock } from '../runtime.js';
import type { RoleCode, UserRow } from '../store/types.js';
import { avatarUrl, orgRef } from './refs.js';

export const ROLE_ORDER: RoleCode[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const ordered = (roles: RoleCode[]): RoleCode[] => ROLE_ORDER.filter((r) => roles.includes(r));

export function meView(m: Mock, u: UserRow) {
  return {
    id: u.id,
    email: u.email.toLowerCase(),
    fullName: u.full_name,
    phone: u.phone,
    avatarUrl: avatarUrl(m, u.avatar_file_id),
    roles: ordered(u.roles),
    organization: orgRef(m, u.organization_id),
    isOrgAdmin: u.is_org_admin,
    totpEnabled: u.totp_enabled,
    channels: channelsView(u),
  };
}

export function channelsView(u: UserRow) {
  return {
    email: u.notification_channels.email === true,
    telegram: u.notification_channels.telegram === true,
    telegramLinked: u.telegram_chat_id !== null,
  };
}

export function userView(m: Mock, u: UserRow) {
  return {
    id: u.id,
    email: u.email.toLowerCase(),
    fullName: u.full_name,
    phone: u.phone,
    avatarUrl: avatarUrl(m, u.avatar_file_id),
    roles: ordered(u.roles),
    isOrgAdmin: u.is_org_admin,
    status: u.status,
    organization: orgRef(m, u.organization_id),
  };
}
