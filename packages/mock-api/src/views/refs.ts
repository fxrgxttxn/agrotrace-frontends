import { publicFileUrl, signedUrl, liveFile } from '../domain/files.js';
import type { Mock } from '../runtime.js';
import type { BatchRow } from '../store/types.js';

export function region(m: Mock, regionId: string): { code: string; name: string } {
  const r = m.store.must('regions', regionId);
  return { code: r.code, name: r.name };
}

export function logoUrl(m: Mock, fileId: string | null): string | null {
  return liveFile(m.store, fileId) ? publicFileUrl(fileId!) : null;
}

export function orgRef(m: Mock, orgId: string) {
  const o = m.store.must('organizations', orgId);
  return { id: o.id, name: o.name, type: o.type, logoUrl: logoUrl(m, o.logo_file_id) };
}

export function productRef(m: Mock, productId: string) {
  const p = m.store.must('products', productId);
  return { id: p.id, name: p.name, category: p.category, imageUrl: logoUrl(m, p.image_file_id) };
}

export function avatarUrl(m: Mock, fileId: string | null): string | null {
  return liveFile(m.store, fileId) ? signedUrl(m.cfg, fileId!) : null;
}

export function actorRef(m: Mock, userId: string | null) {
  if (!userId) return null;
  const u = m.store.get('users', userId);
  if (!u) return null;
  return { id: u.id, fullName: u.full_name, avatarUrl: avatarUrl(m, u.avatar_file_id) };
}

export function batchListItem(m: Mock, b: BatchRow) {
  return {
    id: b.id,
    publicCode: b.public_code,
    product: productRef(m, b.product_id),
    massKg: b.mass_kg,
    status: b.status,
    kind: b.kind,
    holder: orgRef(m, b.holder_org_id),
    origin: orgRef(m, b.origin_org_id),
    harvestedAt: b.harvested_at,
    producedAt: b.produced_at,
    updatedAt: b.updated_at,
    qrGeneratedAt: b.qr_generated_at,
  };
}
