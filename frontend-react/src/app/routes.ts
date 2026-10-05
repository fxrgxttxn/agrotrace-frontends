import type { ComponentType } from 'react';
import type { Access } from './access';

type Loader = () => Promise<ComponentType>;

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

const page =
  <M extends Record<string, unknown>>(mod: () => Promise<M>, name: keyof M & string): Loader =>
  async () =>
    (await mod())[name] as ComponentType;

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
  { path: '/login', title: 'page.login', load: page(auth, 'LoginPage') },
  { path: '/login/2fa', title: 'page.twoFactor', load: page(auth, 'TwoFactorPage') },
  { path: '/password/forgot', title: 'page.passwordForgot', load: page(auth, 'PasswordForgotPage') },
  { path: '/password/reset/:token', title: 'page.passwordReset', load: page(auth, 'PasswordResetPage') },
  { path: '/register', title: 'page.register', load: page(auth, 'RegisterPage') },
  { path: '/invite/:token', title: 'page.invite', load: page(auth, 'InvitePage') },
];

export const CABINET_ROUTES: readonly CabinetRoute[] = [
  {
    path: '/',
    title: 'page.dashboard',
    access: 'auth',
    ops: ['getDashboard'],
    load: page(home, 'DashboardPage'),
  },
  {
    path: '/profile',
    title: 'page.profile',
    access: 'auth',
    ops: ['getMe', 'getMyChannels'],
    load: page(profile, 'ProfilePage'),
  },
  {
    path: '/notifications',
    title: 'page.notifications',
    access: 'auth',
    ops: ['listNotifications'],
    load: page(notifications, 'NotificationsPage'),
  },
  {
    path: '/fields',
    title: 'page.fields',
    access: { roles: [F, I, A] },
    ops: ['listFields'],
    load: page(fields, 'FieldsPage'),
  },
  {
    path: '/fields/new',
    title: 'page.fieldNew',
    access: { roles: [F] },
    ops: ['createField'],
    load: page(fields, 'FieldNewPage'),
  },
  {
    path: '/fields/:id',
    title: 'page.field',
    access: { roles: [F, I, A] },
    ops: ['getField', 'listFieldTreatments'],
    load: page(fields, 'FieldPage'),
  },
  {
    path: '/batches',
    title: 'page.batches',
    access: { roles: [F, P, R, I, A] },
    ops: ['listBatches'],
    load: page(batches, 'BatchesPage'),
  },
  {
    path: '/batches/new',
    title: 'page.batchNew',
    access: { roles: [F] },
    ops: ['createBatch'],
    load: page(batches, 'BatchNewPage'),
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
    load: page(batches, 'BatchPage'),
  },
  {
    path: '/waybills',
    title: 'page.waybills',
    access: { roles: [F, P, R, I] },
    ops: ['listWaybills'],
    load: page(waybills, 'WaybillsPage'),
  },
  {
    path: '/waybills/new',
    title: 'page.waybillNew',
    access: { roles: [F, P] },
    ops: ['createWaybill'],
    load: page(waybills, 'WaybillNewPage'),
  },
  {
    path: '/waybills/:id',
    title: 'page.waybill',
    access: { roles: [F, P, R, I] },
    ops: ['getWaybill'],
    load: page(waybills, 'WaybillPage'),
  },
  {
    path: '/stock',
    title: 'page.stock',
    access: { roles: [P, R] },
    ops: ['listBatches'],
    load: page(stock, 'StockPage'),
  },
  {
    path: '/processing/new',
    title: 'page.processing',
    access: { roles: [P] },
    ops: ['processBatches'],
    load: page(stock, 'ProcessingPage'),
  },
  {
    path: '/qr',
    title: 'page.qr',
    access: { roles: [P, R] },
    ops: ['createBatchQr'],
    load: page(stock, 'QrPage'),
  },
  {
    path: '/lab/tests',
    title: 'page.labTests',
    access: { roles: [L] },
    ops: ['listLabTests'],
    load: page(lab, 'LabTestsPage'),
  },
  {
    path: '/lab/tests/:id',
    title: 'page.labTest',
    access: { roles: [L] },
    ops: ['getLabTest', 'registerLabSample', 'submitLabResults', 'uploadLabProtocol'],
    load: page(lab, 'LabTestPage'),
  },
  {
    path: '/recall-tasks',
    title: 'page.recallTasks',
    access: { roles: [F, P, R] },
    ops: ['listRecallTasks', 'confirmRecallTask'],
    load: page(recalls, 'RecallTasksPage'),
  },
  {
    path: '/recalls',
    title: 'page.recalls',
    access: { roles: [I] },
    ops: ['listRecalls'],
    load: page(recalls, 'RecallsPage'),
  },
  {
    path: '/recalls/new',
    title: 'page.recallNew',
    access: { roles: [I] },
    ops: ['createRecall', 'listBatches', 'getBatch'],
    load: page(recalls, 'RecallNewPage'),
  },
  {
    path: '/recalls/:id',
    title: 'page.recall',
    access: { roles: [I] },
    ops: ['getRecall', 'getRecallGraph'],
    load: page(recalls, 'RecallPage'),
  },
  {
    path: '/complaints',
    title: 'page.complaints',
    access: { roles: [I] },
    ops: ['listComplaints'],
    load: page(complaints, 'ComplaintsPage'),
  },
  {
    path: '/complaints/:id',
    title: 'page.complaint',
    access: { roles: [I] },
    ops: ['getComplaint', 'startComplaintReview', 'decideComplaint', 'listOrganizations'],
    load: page(complaints, 'ComplaintPage'),
  },
  {
    path: '/reports',
    title: 'page.reports',
    access: { roles: [I, A], orgAdmin: true },
    ops: ['downloadReport'],
    load: page(reports, 'ReportsPage'),
  },
  {
    path: '/org/staff',
    title: 'page.staff',
    access: { roles: [], orgAdmin: true },
    ops: ['listUsers', 'inviteUser', 'updateUser', 'uploadOrganizationLogo'],
    load: page(users, 'StaffPage'),
  },
  {
    path: '/admin/organizations',
    title: 'page.organizations',
    access: { roles: [A] },
    ops: ['listAdminOrganizations', 'approveOrganization', 'updateAdminOrganization'],
    load: page(organizations, 'OrganizationsPage'),
  },
  {
    path: '/admin/users',
    title: 'page.users',
    access: { roles: [A] },
    ops: ['listUsers', 'inviteUser', 'updateUser', 'listOrganizations'],
    load: page(users, 'UsersPage'),
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
    load: page(dictionaries, 'DictionaryPage'),
  },
  {
    path: '/admin/audit',
    title: 'page.audit',
    access: { roles: [A, I] },
    ops: ['listAuditLog'],
    load: page(audit, 'AuditPage'),
  },
];
