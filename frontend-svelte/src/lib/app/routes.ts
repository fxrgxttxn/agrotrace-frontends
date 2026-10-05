import type { Access } from './access';

export interface CabinetRoute {
  path: string;
  title: string;
  access: Access;
  ops: readonly string[];
}

export interface PublicAuthRoute {
  path: string;
  title: string;
  guestOnly?: boolean;
}

const F = 'FARMER';
const P = 'PROCESSOR';
const L = 'LAB';
const R = 'RETAILER';
const I = 'INSPECTOR';
const A = 'ADMIN';

export const AUTH_ROUTES: readonly PublicAuthRoute[] = [
  { path: '/login', title: 'page.login', guestOnly: true },
  { path: '/login/2fa', title: 'page.twoFactor', guestOnly: true },
  { path: '/password/forgot', title: 'page.passwordForgot' },
  { path: '/password/reset/:token', title: 'page.passwordReset' },
  { path: '/register', title: 'page.register' },
  { path: '/invite/:token', title: 'page.invite' },
];

export const CABINET_ROUTES: readonly CabinetRoute[] = [
  { path: '/', title: 'page.dashboard', access: 'auth', ops: ['getDashboard'] },
  { path: '/profile', title: 'page.profile', access: 'auth', ops: ['getMe', 'getMyChannels'] },
  { path: '/notifications', title: 'page.notifications', access: 'auth', ops: ['listNotifications'] },
  { path: '/fields', title: 'page.fields', access: { roles: [F, I, A] }, ops: ['listFields'] },
  { path: '/fields/new', title: 'page.fieldNew', access: { roles: [F] }, ops: ['createField'] },
  {
    path: '/fields/:id',
    title: 'page.field',
    access: { roles: [F, I, A] },
    ops: ['getField', 'listFieldTreatments'],
  },
  { path: '/batches', title: 'page.batches', access: { roles: [F, P, R, I, A] }, ops: ['listBatches'] },
  { path: '/batches/new', title: 'page.batchNew', access: { roles: [F] }, ops: ['createBatch'] },
  {
    path: '/batches/:id',
    title: 'page.batch',
    access: 'auth',
    ops: ['getBatch', 'getBatchHistory', 'getBatchPath', 'getBatchGraph', 'getBatchDocuments'],
  },
  { path: '/waybills', title: 'page.waybills', access: { roles: [F, P, R, I] }, ops: ['listWaybills'] },
  { path: '/waybills/new', title: 'page.waybillNew', access: { roles: [F, P] }, ops: ['createWaybill'] },
  { path: '/waybills/:id', title: 'page.waybill', access: { roles: [F, P, R, I] }, ops: ['getWaybill'] },
  { path: '/stock', title: 'page.stock', access: { roles: [P, R] }, ops: ['listBatches'] },
  { path: '/processing/new', title: 'page.processing', access: { roles: [P] }, ops: ['processBatches'] },
  { path: '/qr', title: 'page.qr', access: { roles: [P, R] }, ops: ['createBatchQr'] },
  { path: '/lab/tests', title: 'page.labTests', access: { roles: [L] }, ops: ['listLabTests'] },
  {
    path: '/lab/tests/:id',
    title: 'page.labTest',
    access: { roles: [L] },
    ops: ['getLabTest', 'registerLabSample', 'submitLabResults', 'uploadLabProtocol'],
  },
  {
    path: '/recall-tasks',
    title: 'page.recallTasks',
    access: { roles: [F, P, R] },
    ops: ['listRecallTasks', 'confirmRecallTask'],
  },
  { path: '/recalls', title: 'page.recalls', access: { roles: [I] }, ops: ['listRecalls'] },
  {
    path: '/recalls/new',
    title: 'page.recallNew',
    access: { roles: [I] },
    ops: ['createRecall', 'listBatches', 'getBatch'],
  },
  {
    path: '/recalls/:id',
    title: 'page.recall',
    access: { roles: [I] },
    ops: ['getRecall', 'getRecallGraph'],
  },
  { path: '/complaints', title: 'page.complaints', access: { roles: [I] }, ops: ['listComplaints'] },
  {
    path: '/complaints/:id',
    title: 'page.complaint',
    access: { roles: [I] },
    ops: ['getComplaint', 'startComplaintReview', 'decideComplaint', 'listOrganizations'],
  },
  {
    path: '/reports',
    title: 'page.reports',
    access: { roles: [I, A], orgAdmin: true },
    ops: ['downloadReport'],
  },
  {
    path: '/org/staff',
    title: 'page.staff',
    access: { roles: [], orgAdmin: true },
    ops: ['listUsers', 'inviteUser', 'updateUser', 'uploadOrganizationLogo'],
  },
  {
    path: '/admin/organizations',
    title: 'page.organizations',
    access: { roles: [A] },
    ops: ['listAdminOrganizations', 'approveOrganization', 'updateAdminOrganization'],
  },
  {
    path: '/admin/users',
    title: 'page.users',
    access: { roles: [A] },
    ops: ['listUsers', 'inviteUser', 'updateUser', 'listOrganizations'],
  },
  {
    path: '/admin/dictionaries/:name',
    title: 'page.dictionaries',
    access: { roles: [A] },
    ops: [
      'listDictionary',
      'createDictionaryEntry',
      'updateDictionaryEntry',
      'deleteDictionaryEntry',
      'importDictionary',
      'uploadProductImage',
    ],
  },
  { path: '/admin/audit', title: 'page.audit', access: { roles: [A, I] }, ops: ['listAuditLog'] },
];

export function matchPath(pattern: string, path: string): boolean {
  const p = pattern.split('/');
  const s = path.split('/');
  return p.length === s.length && p.every((seg, i) => (seg.startsWith(':') ? s[i] !== '' : seg === s[i]));
}

export function cabinetRoute(path: string): CabinetRoute | undefined {
  return CABINET_ROUTES.find((r) => r.path === path) ?? CABINET_ROUTES.find((r) => matchPath(r.path, path));
}
