import type { Type } from '@angular/core';
import type { Access } from './access';

type Loader = () => Promise<Type<unknown>>;

export interface CabinetRoute {
  path: string;
  title: string;
  access: Access;
  ops: readonly string[];
  load: Loader;
}

export interface PublicAuthRoute {
  path: string;
  title: string;
  load: Loader;
}

const F = 'FARMER';
const P = 'PROCESSOR';
const L = 'LAB';
const R = 'RETAILER';
const I = 'INSPECTOR';
const A = 'ADMIN';

const auth = () => import('../pages/auth');
const home = () => import('../pages/home');
const profile = () => import('../pages/profile');
const notifications = () => import('../pages/notifications');
const fields = () => import('../pages/fields');
const batches = () => import('../pages/batches');
const waybills = () => import('../pages/waybills');
const stock = () => import('../pages/stock');
const lab = () => import('../pages/lab');
const recalls = () => import('../pages/recalls');
const complaints = () => import('../pages/complaints');
const organizations = () => import('../pages/organizations');
const users = () => import('../pages/users');
const dictionaries = () => import('../pages/dictionaries');
const audit = () => import('../pages/audit');
const reports = () => import('../pages/reports');

export const AUTH_ROUTES: readonly PublicAuthRoute[] = [
  { path: '/login', title: 'page.login', load: () => auth().then((m) => m.LoginPage) },
  { path: '/login/2fa', title: 'page.twoFactor', load: () => auth().then((m) => m.TwoFactorPage) },
  {
    path: '/password/forgot',
    title: 'page.passwordForgot',
    load: () => auth().then((m) => m.PasswordForgotPage),
  },
  {
    path: '/password/reset/:token',
    title: 'page.passwordReset',
    load: () => auth().then((m) => m.PasswordResetPage),
  },
  { path: '/register', title: 'page.register', load: () => auth().then((m) => m.RegisterPage) },
  { path: '/invite/:token', title: 'page.invite', load: () => auth().then((m) => m.InvitePage) },
];

export const CABINET_ROUTES: readonly CabinetRoute[] = [
  {
    path: '/',
    title: 'page.dashboard',
    access: 'auth',
    ops: ['getDashboard'],
    load: () => home().then((m) => m.DashboardPage),
  },
  {
    path: '/profile',
    title: 'page.profile',
    access: 'auth',
    ops: ['getMe', 'getMyChannels'],
    load: () => profile().then((m) => m.ProfilePage),
  },
  {
    path: '/notifications',
    title: 'page.notifications',
    access: 'auth',
    ops: ['listNotifications'],
    load: () => notifications().then((m) => m.NotificationsPage),
  },
  {
    path: '/fields',
    title: 'page.fields',
    access: { roles: [F, I, A] },
    ops: ['listFields'],
    load: () => fields().then((m) => m.FieldsPage),
  },
  {
    path: '/fields/new',
    title: 'page.fieldNew',
    access: { roles: [F] },
    ops: ['createField'],
    load: () => fields().then((m) => m.FieldNewPage),
  },
  {
    path: '/fields/:id',
    title: 'page.field',
    access: { roles: [F, I, A] },
    ops: ['getField', 'listFieldTreatments'],
    load: () => fields().then((m) => m.FieldPage),
  },
  {
    path: '/batches',
    title: 'page.batches',
    access: { roles: [F, P, R, I, A] },
    ops: ['listBatches'],
    load: () => batches().then((m) => m.BatchesPage),
  },
  {
    path: '/batches/new',
    title: 'page.batchNew',
    access: { roles: [F] },
    ops: ['createBatch'],
    load: () => batches().then((m) => m.BatchNewPage),
  },
  {
    path: '/batches/:id',
    title: 'page.batch',
    access: 'auth',
    ops: [
      'getBatch',
      'getBatchHistory',
      'getBatchPath',
      'getBatchGraph',
      'getBatchDocuments',
      'listLabTests',
    ],
    load: () => batches().then((m) => m.BatchPage),
  },
  {
    path: '/waybills',
    title: 'page.waybills',
    access: { roles: [F, P, R, I] },
    ops: ['listWaybills'],
    load: () => waybills().then((m) => m.WaybillsPage),
  },
  {
    path: '/waybills/new',
    title: 'page.waybillNew',
    access: { roles: [F, P] },
    ops: ['createWaybill'],
    load: () => waybills().then((m) => m.WaybillNewPage),
  },
  {
    path: '/waybills/:id',
    title: 'page.waybill',
    access: { roles: [F, P, R, I] },
    ops: ['getWaybill'],
    load: () => waybills().then((m) => m.WaybillPage),
  },
  {
    path: '/stock',
    title: 'page.stock',
    access: { roles: [P, R] },
    ops: ['listBatches'],
    load: () => stock().then((m) => m.StockPage),
  },
  {
    path: '/processing/new',
    title: 'page.processing',
    access: { roles: [P] },
    ops: ['processBatches'],
    load: () => stock().then((m) => m.ProcessingPage),
  },
  {
    path: '/qr',
    title: 'page.qr',
    access: { roles: [P, R] },
    ops: ['createBatchQr'],
    load: () => stock().then((m) => m.QrPage),
  },
  {
    path: '/lab/tests',
    title: 'page.labTests',
    access: { roles: [L] },
    ops: ['listLabTests'],
    load: () => lab().then((m) => m.LabTestsPage),
  },
  {
    path: '/lab/tests/:id',
    title: 'page.labTest',
    access: { roles: [L] },
    ops: ['getLabTest', 'registerLabSample', 'submitLabResults', 'uploadLabProtocol'],
    load: () => lab().then((m) => m.LabTestPage),
  },
  {
    path: '/recall-tasks',
    title: 'page.recallTasks',
    access: { roles: [F, P, R] },
    ops: ['listRecallTasks', 'confirmRecallTask'],
    load: () => recalls().then((m) => m.RecallTasksPage),
  },
  {
    path: '/recalls',
    title: 'page.recalls',
    access: { roles: [I] },
    ops: ['listRecalls'],
    load: () => recalls().then((m) => m.RecallsPage),
  },
  {
    path: '/recalls/new',
    title: 'page.recallNew',
    access: { roles: [I] },
    ops: ['createRecall', 'listBatches', 'getBatch'],
    load: () => recalls().then((m) => m.RecallNewPage),
  },
  {
    path: '/recalls/:id',
    title: 'page.recall',
    access: { roles: [I] },
    ops: ['getRecall', 'getRecallGraph'],
    load: () => recalls().then((m) => m.RecallPage),
  },
  {
    path: '/complaints',
    title: 'page.complaints',
    access: { roles: [I] },
    ops: ['listComplaints'],
    load: () => complaints().then((m) => m.ComplaintsPage),
  },
  {
    path: '/complaints/:id',
    title: 'page.complaint',
    access: { roles: [I] },
    ops: ['getComplaint', 'startComplaintReview', 'decideComplaint', 'listOrganizations'],
    load: () => complaints().then((m) => m.ComplaintPage),
  },
  {
    path: '/reports',
    title: 'page.reports',
    access: { roles: [I, A], orgAdmin: true },
    ops: ['downloadReport'],
    load: () => reports().then((m) => m.ReportsPage),
  },
  {
    path: '/org/staff',
    title: 'page.staff',
    access: { roles: [], orgAdmin: true },
    ops: ['listUsers', 'inviteUser', 'updateUser', 'uploadOrganizationLogo'],
    load: () => users().then((m) => m.StaffPage),
  },
  {
    path: '/admin/organizations',
    title: 'page.organizations',
    access: { roles: [A] },
    ops: ['listAdminOrganizations', 'approveOrganization', 'updateAdminOrganization'],
    load: () => organizations().then((m) => m.OrganizationsPage),
  },
  {
    path: '/admin/users',
    title: 'page.users',
    access: { roles: [A] },
    ops: ['listUsers', 'inviteUser', 'updateUser', 'listOrganizations'],
    load: () => users().then((m) => m.UsersPage),
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
    load: () => dictionaries().then((m) => m.DictionaryPage),
  },
  {
    path: '/admin/audit',
    title: 'page.audit',
    access: { roles: [A, I] },
    ops: ['listAuditLog'],
    load: () => audit().then((m) => m.AuditPage),
  },
];

export function matchPath(pattern: string, path: string): boolean {
  const a = pattern.split('/');
  const b = path.split(/[?#]/, 1)[0]!.split('/');
  return a.length === b.length && a.every((seg, i) => (seg.startsWith(':') ? b[i] !== '' : seg === b[i]));
}
