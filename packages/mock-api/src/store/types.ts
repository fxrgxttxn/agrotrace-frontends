export type RoleCode = 'FARMER' | 'PROCESSOR' | 'LAB' | 'RETAILER' | 'INSPECTOR' | 'ADMIN';
export type OrgType = 'FARM' | 'PROCESSOR' | 'LAB' | 'RETAILER' | 'AUTHORITY' | 'PLATFORM';
export type BatchStatus =
  | 'Created'
  | 'OnTest'
  | 'Approved'
  | 'InTransit'
  | 'Accepted'
  | 'Processed'
  | 'OnSale'
  | 'Sold'
  | 'Blocked'
  | 'Recalled'
  | 'WrittenOff';

export interface RegionRow {
  id: string;
  code: string;
  name: string;
}

export interface OrganizationRow {
  id: string;
  type: OrgType;
  name: string;
  inn: string;
  address: string | null;
  region_id: string;
  trust_rating: number | null;
  status: 'PENDING' | 'MANUAL_CHECK' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';
  logo_file_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

export interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  password: string | null;
  full_name: string;
  phone: string | null;
  is_org_admin: boolean;
  roles: RoleCode[];
  totp_secret: string | null;
  totp_enabled: boolean;
  telegram_chat_id: string | null;
  notification_channels: { email: boolean; telegram: boolean };
  avatar_file_id: string | null;
  failed_logins: number;
  locked_until: string | null;
  status: 'INVITED' | 'ACTIVE' | 'BLOCKED';
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
}

export type FileKind = 'AVATAR' | 'LOGO' | 'PRODUCT_IMAGE' | 'LAB_PROTOCOL' | 'QR' | 'REPORT';

export type FileContent =
  | { type: 'asset'; url?: string; variants?: Record<string, string> }
  | { type: 'bytes'; data: Uint8Array; variants?: Record<string, Uint8Array> }
  | { type: 'blob' };

export interface FileRow {
  id: string;
  kind: FileKind;
  original_name: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  variants: Record<string, { sha256: string; size: number }>;
  owner_id: string | null;
  created_at: string;
  deleted_at: string | null;
  content: FileContent;
  regen?: { type: 'protocol'; testId: string } | { type: 'qrPng' | 'qrPdf'; batchId: string };
}

export interface ProductRow {
  id: string;
  name: string;
  category: string;
  loss_norm_percent: string;
  image_file_id: string | null;
  mercury_code: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SubstanceRow {
  id: string;
  name: string;
  type: 'PESTICIDE' | 'FERTILIZER';
  waiting_period_days: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface IndicatorRow {
  id: string;
  name: string;
  unit: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface NormRow {
  id: string;
  product_id: string;
  indicator_id: string;
  max_value: string;
  created_at: string;
  updated_at: string;
}

export interface FieldRow {
  id: string;
  organization_id: string;
  name: string;
  area_ha: string;
  geometry: unknown;
  region_id: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

export interface TreatmentRow {
  id: string;
  field_id: string;
  substance_id: string;
  dose: string;
  dose_unit: string;
  applied_at: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

export interface BatchRow {
  id: string;
  public_code: string;
  product_id: string;
  origin_org_id: string;
  holder_org_id: string;
  field_id: string | null;
  kind: 'RAW' | 'DERIVED';
  mass_kg: string;
  harvested_at: string | null;
  produced_at: string | null;
  status: BatchStatus;
  test_required: boolean;
  test_reason: string;
  qr_generated_at: string | null;
  qr_png_file_id: string | null;
  qr_pdf_file_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

export interface BatchDocumentRow {
  id: string;
  batch_id: string;
  kind: 'VSD';
  external_uuid: string | null;
  number: string | null;
  issue_date: string | null;
  vsd_status: string | null;
  import_status: 'PENDING' | 'IMPORTED' | 'NOT_FOUND' | 'FAILED';
  payload: Record<string, unknown> | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface BatchLinkRow {
  id: string;
  parent_batch_id: string;
  child_batch_id: string;
  mass_used_kg: string;
  created_at: string;
}

export interface HistoryRow {
  batch_id: string;
  from_status: BatchStatus | null;
  to_status: BatchStatus;
  changed_by: string | null;
  reason: string;
  changed_at: string;
}

export interface WaybillRow {
  id: string;
  number: string;
  sender_org_id: string;
  receiver_org_id: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED';
  reject_reason: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

export interface WaybillItemRow {
  id: string;
  waybill_id: string;
  batch_id: string;
  mass_declared_kg: string;
  mass_actual_kg: string | null;
  discrepancy_act: string | null;
}

export interface LabTestRow {
  id: string;
  batch_id: string;
  lab_org_id: string;
  reason: 'PLANNED' | 'RISK' | 'COMPLAINT' | 'INSPECTOR';
  status: 'QUEUED' | 'SAMPLED' | 'DONE' | 'ESCALATED' | 'CANCELLED';
  conclusion: 'PASS' | 'FAIL' | null;
  sampled_at: string | null;
  completed_at: string | null;
  due_at: string;
  escalated_at: string | null;
  protocol_file_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
  recall_id: string | null;
}

export interface LabResultRow {
  id: string;
  lab_test_id: string;
  indicator_id: string;
  value: string;
  norm_value_snapshot: string;
  is_exceeded: boolean;
}

export interface RecallRow {
  id: string;
  source_batch_id: string;
  trigger: 'LAB' | 'INSPECTOR' | 'COMPLAINT';
  reason: string;
  status: 'OPEN' | 'CLOSED';
  block_upstream: boolean;
  lab_test_id: string | null;
  complaint_id: string | null;
  opened_at: string;
  closed_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

export interface RecallBatchRow {
  id: string;
  recall_id: string;
  batch_id: string;
  direction: 'SOURCE' | 'DOWN' | 'UP';
  depth: number;
  status_before: BatchStatus;
}

export interface RecallTaskRow {
  id: string;
  recall_id: string;
  holder_org_id: string;
  batch_id: string;
  due_at: string;
  status: 'OPEN' | 'CONFIRMED' | 'OVERDUE';
  confirmed_by: string | null;
  confirmed_at: string | null;
  escalated_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ComplaintRow {
  id: string;
  batch_id: string;
  text: string;
  contact: string | null;
  status: 'NEW' | 'IN_REVIEW' | 'DECIDED';
  decision: 'REJECT' | 'LAB_TEST' | 'RECALL' | null;
  decision_comment: string | null;
  inspector_id: string | null;
  lab_test_id: string | null;
  recall_id: string | null;
  decided_at: string | null;
  ip: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface NotificationRow {
  id: string;
  seq: number;
  user_id: string;
  type: string;
  payload: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

export interface AuditRow {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  diff: Record<string, unknown>;
  ip: string | null;
  backend: string;
  request_id: string | null;
  created_at: string;
}

export interface Tables {
  regions: RegionRow[];
  files: FileRow[];
  products: ProductRow[];
  substances: SubstanceRow[];
  indicators: IndicatorRow[];
  norms: NormRow[];
  organizations: OrganizationRow[];
  users: UserRow[];
  refresh_tokens: RefreshTokenRow[];
  fields: FieldRow[];
  treatments: TreatmentRow[];
  batches: BatchRow[];
  batch_documents: BatchDocumentRow[];
  batch_links: BatchLinkRow[];
  batch_status_history: HistoryRow[];
  waybills: WaybillRow[];
  waybill_items: WaybillItemRow[];
  lab_tests: LabTestRow[];
  lab_results: LabResultRow[];
  recalls: RecallRow[];
  recall_batches: RecallBatchRow[];
  recall_tasks: RecallTaskRow[];
  complaints: ComplaintRow[];
  notifications: NotificationRow[];
  audit_log: AuditRow[];
}

export type TableName = keyof Tables;

export interface KvEntry {
  value: unknown;
  expiresAt: number | null;
}

export interface Sequences {
  batch: number;
  waybill: number;
  notification: number;
  audit: number;
  id: number;
}

export interface Principal {
  userId: string;
  orgId: string;
  roles: RoleCode[];
  orgAdmin: boolean;
}
