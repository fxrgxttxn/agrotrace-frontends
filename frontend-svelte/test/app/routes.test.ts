import { describe, expect, it } from 'vitest';
import { ALL_ROLES, canAccess, type Role } from '../../src/lib/app/access';
import { isCurrent, navFor, NOTIFICATIONS_ITEM, PROFILE_ITEM, ROLE_NAV } from '../../src/lib/app/nav';
import { AUTH_ROUTES, CABINET_ROUTES } from '../../src/lib/app/routes';
import { operation } from '../msw/fromContract';

const SPEC_PATHS = [
  '/login',
  '/login/2fa',
  '/password/forgot',
  '/password/reset/:token',
  '/register',
  '/invite/:token',
  '/',
  '/profile',
  '/notifications',
  '/fields',
  '/fields/new',
  '/fields/:id',
  '/batches',
  '/batches/new',
  '/batches/:id',
  '/waybills',
  '/waybills/new',
  '/waybills/:id',
  '/stock',
  '/processing/new',
  '/qr',
  '/lab/tests',
  '/lab/tests/:id',
  '/recall-tasks',
  '/recalls',
  '/recalls/new',
  '/recalls/:id',
  '/complaints',
  '/complaints/:id',
  '/reports',
  '/org/staff',
  '/admin/organizations',
  '/admin/users',
  '/admin/dictionaries/:name',
  '/admin/audit',
];

const viewer = (role: Role, isOrgAdmin = false) => ({ roles: [role], isOrgAdmin });

const FILES = Object.keys(import.meta.glob('/src/routes/**/+page.svelte'));
const GUARDS = import.meta.glob<string>('/src/routes/**/+page.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function urlOf(file: string): string {
  const segments = file
    .replace(/^\/src\/routes/, '')
    .replace(/\/\+page\.svelte$/, '')
    .split('/')
    .filter((s) => s && !/^\(.*\)$/.test(s))
    .map((s) => s.replace(/^\[(\w+)\]$/, ':$1'));
  return `/${segments.join('/')}`;
}

describe('routes (§9.4)', () => {
  it('are exactly the spec routes', () => {
    expect([...AUTH_ROUTES, ...CABINET_ROUTES].map((r) => r.path).sort()).toEqual([...SPEC_PATHS].sort());
  });

  it('every spec route is a file route; the only others are /403, the 404 catch-all and the public group', () => {
    const files = FILES.map(urlOf);
    expect(files.filter((p) => !SPEC_PATHS.includes(p)).sort()).toEqual(
      ['/403', '/[...rest]', '/p/:code', '/p/:code/complaint', '/p/[...rest]'].sort(),
    );
    expect(SPEC_PATHS.filter((p) => !files.includes(p))).toEqual([]);
  });

  it('cabinet routes live in the (cabinet) group and run the role guard of their own path', () => {
    for (const r of CABINET_ROUTES) {
      const file = FILES.find((f) => urlOf(f) === r.path)!;
      expect(file, r.path).toContain('/(app)/(cabinet)/');
      expect(GUARDS[file.replace(/\.svelte$/, '.ts')], r.path).toContain(`requireRole('${r.path}')`);
    }
    for (const r of AUTH_ROUTES) {
      const file = FILES.find((f) => urlOf(f) === r.path)!;
      expect(file, r.path).toContain('/(app)/(auth)/');
      const guard = GUARDS[file.replace(/\.svelte$/, '.ts')] ?? '';
      expect(guard.includes('guestOnly'), r.path).toBe(Boolean(r.guestOnly));
    }
  });

  it('the public group has no cabinet module (no session, no shell)', () => {
    const publicFiles = import.meta.glob<string>('/src/routes/(public)/**/*', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const publicLib = import.meta.glob<string>('/src/lib/public/**/*', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    for (const [file, src] of Object.entries({ ...publicFiles, ...publicLib }))
      expect(src, file).not.toMatch(/\$lib\/(app|shell|ui|pages)\b|\.\.\/(app|shell|ui|pages)\//);
  });

  it('every role a route admits is admitted by the x-roles of every operation the screen needs', () => {
    const problems: string[] = [];
    for (const r of CABINET_ROUTES)
      for (const opId of r.ops) {
        const xRoles: string[] = operation(opId).op['x-roles'];
        if (xRoles.includes('ANY')) continue;
        const admitted = r.access === 'auth' ? ALL_ROLES : r.access.roles;
        for (const role of admitted)
          if (!xRoles.includes(role)) problems.push(`${r.path} admits ${role}, ${opId} does not`);
        if (
          r.access !== 'auth' &&
          r.access.orgAdmin &&
          !operation(opId).op['x-org-admin'] &&
          xRoles.length < ALL_ROLES.length
        )
          problems.push(
            `${r.path} admits heads of organization of any role, ${opId} only ${xRoles.join(',')}`,
          );
      }
    expect(problems).toEqual([]);
  });

  it('matches the §9.4 role column', () => {
    const allowed = (path: string) =>
      ALL_ROLES.filter((role) =>
        canAccess(viewer(role), CABINET_ROUTES.find((r) => r.path === path)!.access),
      );
    expect(allowed('/fields')).toEqual(['FARMER', 'INSPECTOR', 'ADMIN']);
    expect(allowed('/fields/new')).toEqual(['FARMER']);
    expect(allowed('/batches')).toEqual(['FARMER', 'PROCESSOR', 'RETAILER', 'INSPECTOR', 'ADMIN']);
    expect(allowed('/waybills')).toEqual(['FARMER', 'PROCESSOR', 'RETAILER', 'INSPECTOR']);
    expect(allowed('/stock')).toEqual(['PROCESSOR', 'RETAILER']);
    expect(allowed('/processing/new')).toEqual(['PROCESSOR']);
    expect(allowed('/lab/tests')).toEqual(['LAB']);
    expect(allowed('/recall-tasks')).toEqual(['FARMER', 'PROCESSOR', 'RETAILER']);
    expect(allowed('/recalls')).toEqual(['INSPECTOR']);
    expect(allowed('/reports')).toEqual(['INSPECTOR', 'ADMIN']);
    expect(allowed('/org/staff')).toEqual([]);
    expect(allowed('/admin/audit')).toEqual(['INSPECTOR', 'ADMIN']);
    const staff = CABINET_ROUTES.find((r) => r.path === '/org/staff')!.access;
    expect(canAccess(viewer('LAB', true), staff)).toBe(true);
    const reports = CABINET_ROUTES.find((r) => r.path === '/reports')!.access;
    expect(canAccess(viewer('FARMER', true), reports)).toBe(true);
    expect(canAccess(viewer('FARMER', false), reports)).toBe(false);
  });
});

describe('menu (§9.5)', () => {
  it('every menu item of every role leads to a route that role may open', () => {
    for (const role of ALL_ROLES)
      for (const head of [false, true]) {
        const items = navFor(viewer(role, head));
        const all = [...ROLE_NAV[role]];
        if (!head) expect(items.map((i) => i.key)).toEqual(all);
        else expect(items.map((i) => i.key)).toEqual([...new Set([...all, 'staff', 'reports'])]);
      }
  });

  it('per role', () => {
    const labels = (role: Role, head = false) => navFor(viewer(role, head)).map((i) => i.href);
    expect(labels('FARMER')).toEqual(['/', '/fields', '/batches', '/waybills', '/recall-tasks']);
    expect(labels('FARMER', true)).toEqual([
      '/',
      '/fields',
      '/batches',
      '/waybills',
      '/recall-tasks',
      '/org/staff',
      '/reports',
    ]);
    expect(labels('LAB')).toEqual(['/', '/lab/tests']);
    expect(labels('ADMIN')).toContain('/admin/dictionaries/products');
    expect(labels('INSPECTOR')).toEqual([
      '/',
      '/batches',
      '/recalls',
      '/complaints',
      '/fields',
      '/waybills',
      '/reports',
      '/admin/audit',
    ]);
  });

  it('a user with two roles gets the union, without duplicates', () => {
    const keys = navFor({ roles: ['PROCESSOR', 'RETAILER'], isOrgAdmin: false }).map((i) => i.key);
    expect(keys).toEqual(['dashboard', 'waybills', 'stock', 'processing', 'batches', 'qr', 'recallTasks']);
  });

  it('marks the section of nested routes as current, the dashboard only at /', () => {
    const [dashboard, fields] = navFor(viewer('FARMER'));
    expect(isCurrent(fields!, '/fields/123')).toBe(true);
    expect(isCurrent(fields!, '/fieldsx')).toBe(false);
    expect(isCurrent(dashboard!, '/')).toBe(true);
    expect(isCurrent(dashboard!, '/fields')).toBe(false);
  });
});

describe('menu icons', () => {
  it('no two items of one menu (with «Ещё»: notifications, profile) share an icon', () => {
    for (const role of ALL_ROLES)
      for (const head of [false, true]) {
        const icons = [...navFor(viewer(role, head)), NOTIFICATIONS_ITEM, PROFILE_ITEM].map((i) => i.icon);
        expect(new Set(icons).size, `${role}${head ? ' head' : ''}: ${icons.join(',')}`).toBe(icons.length);
      }
    const icons = navFor({ roles: [...ALL_ROLES], isOrgAdmin: true }).map((i) => i.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
