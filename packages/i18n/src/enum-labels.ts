import type { T } from './problem.js';

export const ENUM_LABELS: Record<string, string> = {
  ProblemCode: 'errors',
  RoleCode: 'role',
  BatchStatus: 'status.batch',
  OrganizationType: 'orgType',
  RegistrableOrganizationType: 'orgType',
  ProductCategory: 'productCategory',
  SubstanceType: 'substanceType',
  'RegisterOrganizationResponse.status': 'status.organization',
  UserStatus: 'status.user',
  'UserPatch.status': 'status.user',
  OrganizationStatus: 'status.organization',
  'OrganizationAdminPatch.status': 'status.organization',
  SafetyStatus: 'status.safety',
  'PublicBatch.labSummary.lastConclusion': 'labConclusion',
  NotificationType: 'notification.{value}.label',
  DoseUnit: 'doseUnit',
  BatchKind: 'batchKind',
  TestReason: 'testReason',
  BatchActionName: 'batchAction',
  BatchStatusReason: 'batchStatusReason',
  VsdStatus: 'status.vsd',
  VsdImportStatus: 'status.vsdImport',
  WaybillStatus: 'status.waybill',
  WaybillActionName: 'waybillAction',
  LabTestStatus: 'status.labTest',
  LabTestReason: 'labTestReason',
  LabConclusion: 'labConclusion',
  LabTestActionName: 'labTestAction',
  RecallTrigger: 'recallTrigger',
  RecallStatus: 'status.recall',
  RecallDirection: 'recallDirection',
  RecallTaskStatus: 'status.task',
  ComplaintStatus: 'status.complaint',
  ComplaintDecisionType: 'complaintDecision',
  DashboardScope: 'dashboardScope',
  ReportType: 'reportType',
  ReportFormat: 'reportFormat',
  AuditEntityType: 'auditEntity',
  'AuditEntry.backend': 'backend',
  DictionaryName: 'dictionary',
  'param:origin': 'batchOrigin',
  'param:holder': 'batchHolder',
  'param:direction': 'waybillDirection',
  'param:backend': 'backend',
};

export function enumLabel(t: T, where: string, value: string): string {
  const ns = ENUM_LABELS[where];
  if (!ns) return value;
  const key = ns.includes('{value}') ? ns.replace('{value}', value) : `${ns}.${value}`;
  const label = t(key);
  return label === key ? value : label;
}
