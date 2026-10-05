import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiProblem, withVariant, type Schemas } from '@agrotrace/api-client';
import { enumLabel } from '@agrotrace/i18n';
import { UserInviteSchema } from '@agrotrace/validation';
import { IMAGE_TYPES, ROLE_OF_TYPE, USER_TONE } from '../app/admin';
import { call, errorText, errorTone, useDialogAlert } from '../app/api';
import { useScreenScope, useScreenToast } from '../app/cache';
import { errorOf, FORM_GRID, Submit, useSchemaForm, wireSchema } from '../app/forms';
import { t } from '../app/i18n';
import { ImageUpload } from '../app/ImageUpload';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { OrgPicker } from '../app/OrgPicker';
import { useMe, useSession } from '../app/session';
import type { Role } from '../app/access';
import {
  AreaLoading,
  Avatar,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Chip,
  Dialog,
  DialogMessage,
  Empty,
  Field,
  FieldSet,
  Input,
  ListChanged,
  LoadFailed,
  Page,
  PageToolbar,
  Pagination,
  Radio,
  Select,
  Table,
  type Column,
} from '../ui';

type User = Schemas['User'];
type UserStatus = Schemas['UserStatus'];

const SIZE = 20;
const STACK = { display: 'grid', gap: 'var(--sp-4)' } as const;
const GAP = { display: 'grid', gap: 'var(--sp-5)' } as const;
const STATUSES: readonly UserStatus[] = ['INVITED', 'ACTIVE', 'BLOCKED'];
const ROLES: readonly Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const LOGO_MAX_BYTES = 2097152;
const LOGO_TYPES = [...IMAGE_TYPES, 'image/svg+xml'];

const ADMIN_SPEC: ListSpec = {
  sort: ['fullName', 'email', 'createdAt'],
  enums: { status: STATUSES, role: ROLES },
  uuids: ['organizationId'],
  texts: ['q'],
};
const STAFF_SPEC: ListSpec = {
  sort: ['fullName', 'email', 'createdAt'],
  enums: { status: STATUSES },
  texts: ['q'],
};

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;

export function UsersPage() {
  return <UsersScreen admin />;
}

export function StaffPage() {
  return <UsersScreen admin={false} />;
}

function UsersScreen({ admin }: { admin: boolean }) {
  const { api } = useSession();
  const me = useMe();
  const queryClient = useQueryClient();
  const toast = useScreenToast();
  const path = admin ? '/admin/users' : '/org/staff';
  const list = useListParams(path, admin ? ADMIN_SPEC : STAFF_SPEC);
  const q = list.get('q');
  const status = list.get('status');
  const role = list.get('role');
  const organizationId = list.get('organizationId');
  const sort = list.sort;
  const count = [status, role, organizationId].filter(Boolean).length;
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  const query = useQuery({
    queryKey: [
      'users',
      { admin, page: list.page, sort: list.params.get('sort'), q, status, role, organizationId },
    ],
    meta: { failed: 'users.failed' },
    queryFn: () =>
      call<Schemas['UserPage']>(
        api.GET('/users', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(status ? { status: status as UserStatus } : {}),
              ...(role ? { role: role as Role } : {}),
              ...(organizationId ? { organizationId } : {}),
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
  const items = query.data?.items ?? [];
  const gap = query.data ? listGap(query.data, list.page, SIZE) : null;
  const { clampPage } = list;
  useEffect(() => {
    if (query.data && gap === 'pastEnd') clampPage(query.data.total, SIZE);
  }, [query.data, gap, clampPage]);

  const reread = () => void queryClient.invalidateQueries({ queryKey: ['users'] });

  const columns: Column<User>[] = [
    {
      key: 'user',
      header: t('users.user'),
      primary: true,
      sortField: 'fullName',
      cell: (u) => (
        <span style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', minWidth: 0 }}>
          <Avatar
            name={u.fullName}
            src={u.avatarUrl ? withVariant(u.avatarUrl, 96) : null}
            size="s"
            decorative
          />
          <span className="at-table__primary">
            <span>{u.fullName}</span>
            <span className="at-table__sub">{u.email}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('users.status'),
      status: true,
      cell: (u) => <Chip tone={USER_TONE[u.status]}>{enumLabel(t, 'UserStatus', u.status)}</Chip>,
    },
    ...(admin
      ? [{ key: 'org', header: t('users.organization'), cell: (u: User) => u.organization.name }]
      : []),
    {
      key: 'role',
      header: t('users.role'),
      cell: (u) => (
        <span className="at-table__primary">
          <span>{u.roles.map((r) => enumLabel(t, 'RoleCode', r)).join(', ')}</span>
          {u.isOrgAdmin && <span className="at-table__sub">{t('users.head')}</span>}
        </span>
      ),
    },
  ];

  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed
          text={t('users.failed')}
          busy={query.isFetching}
          onRetry={() => void query.refetch()}
          onReset={isBadListQuery(query.error) ? list.reset : undefined}
        />
      );
    if (!query.data || gap === 'pastEnd') return <AreaLoading />;
    if (gap === 'changed')
      return <ListChanged busy={query.isFetching} onReload={() => void query.refetch()} />;
    if (items.length === 0)
      return (
        <Card>
          {q || count ? (
            <Empty
              art="empty-search"
              text={t('empty.search')}
              action={
                <Button variant="primary" onClick={list.reset}>
                  {t('filters.reset')}
                </Button>
              }
            />
          ) : (
            <Empty art="empty-search" text={t('empty.users')} />
          )}
        </Card>
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={STACK}>
        <Table
          cards
          caption={admin ? t('page.users') : t('page.staff')}
          columns={columns}
          rows={items}
          rowKey={(u) => u.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'fullName,asc', label: t('users.sort.name') },
            { value: 'email,asc', label: t('users.sort.email') },
            { value: 'createdAt,desc', label: t('users.sort.created') },
          ]}
          actions={(u) =>
            u.id === me.id ? null : (
              <Button
                size="s"
                aria-label={t('users.editOf', { name: u.fullName })}
                onClick={() => setEditing(u)}
              >
                {t('users.edit')}
              </Button>
            )
          }
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Page
      title={admin ? t('page.users') : t('page.staff')}
      actions={
        <Button variant="primary" icon="plus" onClick={() => setInviting(true)}>
          {t('action.invite')}
        </Button>
      }
    >
      <div style={GAP}>
        {!admin && <LogoCard />}
        <div style={STACK}>
          <PageToolbar
            search={{
              label: t('users.search'),
              placeholder: t('users.searchPlaceholder'),
              value: q,
              onChange: (text) => list.set({ q: text }),
            }}
            count={count}
            filters={
              <>
                <Field id="filter-status" label={t('users.status')}>
                  <Select value={status} onChange={(e) => list.set({ status: e.target.value })}>
                    <option value="">{t('filters.any')}</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {enumLabel(t, 'UserStatus', s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                {admin && (
                  <Field id="filter-role" label={t('users.role')}>
                    <Select value={role} onChange={(e) => list.set({ role: e.target.value })}>
                      <option value="">{t('filters.any')}</option>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {enumLabel(t, 'RoleCode', r)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                {admin && (
                  <OrgPicker
                    id="filter-org"
                    label={t('users.organization')}
                    value={organizationId}
                    onChange={(id) => list.set({ organizationId: id })}
                  />
                )}
              </>
            }
          />
          {content()}
        </div>
      </div>
      {inviting && (
        <InviteDialog
          admin={admin}
          onClose={() => setInviting(false)}
          onDone={(u) => {
            setInviting(false);
            reread();
            toast.done({ tone: 'ok', text: t('users.invited', { email: u.email }) });
          }}
        />
      )}
      {editing && (
        <EditDialog
          user={editing}
          onClose={() => setEditing(null)}
          onDone={(u) => {
            setEditing(null);
            reread();
            toast.done({ tone: 'ok', text: t('users.saved', { name: u.fullName }) });
          }}
          onStale={(text) => {
            setEditing(null);
            reread();
            toast.push({ tone: 'danger', text });
          }}
        />
      )}
    </Page>
  );
}

interface InviteValues {
  email: string;
  fullName: string;
  organizationId: string;
  isOrgAdmin: boolean;
}

function InviteDialog({
  admin,
  onClose,
  onDone,
}: {
  admin: boolean;
  onClose: () => void;
  onDone: (u: User) => void;
}) {
  const { api } = useSession();
  const me = useMe();
  const [orgType, setOrgType] = useState(me.organization.type);
  const role = ROLE_OF_TYPE[orgType];
  const toWire = (v: InviteValues) => ({
    email: v.email.trim(),
    fullName: v.fullName.trim(),
    roles: [role],
    isOrgAdmin: v.isOrgAdmin,
    ...(admin && v.organizationId ? { organizationId: v.organizationId } : {}),
  });
  const schema = wireSchema<InviteValues>(UserInviteSchema, toWire);
  const { form, alert, wait, fail, message, handOff } = useSchemaForm<InviteValues>(
    schema,
    { email: '', fullName: '', organizationId: '', isOrgAdmin: false },
    ['email', 'fullName', 'organizationId', 'isOrgAdmin'],
    undefined,
    { dialog: true },
  );
  const close = () => {
    handOff();
    onClose();
  };
  const organizationId = form.watch('organizationId');
  const [busy, setBusy] = useState(false);
  const submit = form.handleSubmit(async (body) => {
    alert.clear();
    setBusy(true);
    try {
      onDone(await call<User>(api.POST('/users', { body: body as unknown as Schemas['UserInvite'] })));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  });
  return (
    <Dialog
      open
      onClose={close}
      title={t('users.inviteTitle')}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Submit busy={busy} wait={wait} form="invite-form">
            {t('action.invite')}
          </Submit>
        </>
      }
    >
      <form id="invite-form" noValidate onSubmit={(e) => void submit(e)} style={FORM_GRID}>
        <DialogMessage text={message} />
        <Field id="invite-name" label={t('field.fullName')} error={errorOf(form, 'fullName')}>
          <Input autoComplete="off" {...form.register('fullName')} />
        </Field>
        <Field id="invite-email" label={t('field.email')} error={errorOf(form, 'email')}>
          <Input type="email" autoComplete="off" {...form.register('email')} />
        </Field>
        {admin && (
          <OrgPicker
            id="invite-org"
            label={t('users.inviteOrg')}
            value={organizationId}
            error={errorOf(form, 'organizationId')}
            onChange={(id) => form.setValue('organizationId', id ?? '')}
            onOrg={(org) => setOrgType(org?.type ?? me.organization.type)}
          />
        )}
        <p style={{ margin: 0 }}>{t('users.inviteRole', { role: enumLabel(t, 'RoleCode', role) })}</p>
        <Checkbox {...form.register('isOrgAdmin')}>{t('field.isOrgAdmin')}</Checkbox>
      </form>
    </Dialog>
  );
}

function EditDialog({
  user,
  onClose,
  onDone,
  onStale,
}: {
  user: User;
  onClose: () => void;
  onDone: (u: User) => void;
  onStale: (text: string) => void;
}) {
  const { api } = useSession();
  const [isOrgAdmin, setIsOrgAdmin] = useState(user.isOrgAdmin);
  const [status, setStatus] = useState<UserStatus>(user.status);
  const [busy, setBusy] = useState(false);
  const failure = useDialogAlert();
  const submit = async () => {
    const body = {
      ...(isOrgAdmin !== user.isOrgAdmin ? { isOrgAdmin } : {}),
      ...(status !== user.status && status !== 'INVITED' ? { status } : {}),
    };
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    failure.clear();
    try {
      onDone(
        await call<User>(
          api.PATCH('/users/{id}', { params: { path: { id: user.id } }, body: body as never }),
        ),
      );
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION')
        onStale(
          t('users.stateChanged', {
            name: user.fullName,
            status: enumLabel(t, 'UserStatus', String(e.params?.from ?? '')),
          }),
        );
      else if (e instanceof ApiProblem && e.status === 404) onStale(t('users.gone', { name: user.fullName }));
      else failure.show(errorText(e), errorTone(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    failure.handOff();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      title={t('users.editTitle', { name: user.fullName })}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            {t('action.save')}
          </Button>
        </>
      }
    >
      <div style={FORM_GRID}>
        <DialogMessage text={failure.message} />
        <Checkbox checked={isOrgAdmin} onChange={(e) => setIsOrgAdmin(e.target.checked)}>
          {t('field.isOrgAdmin')}
        </Checkbox>
        {user.status === 'INVITED' ? (
          <p style={{ margin: 0 }}>{t('users.invitedNote')}</p>
        ) : (
          <FieldSet legend={t('users.status')}>
            {(['ACTIVE', 'BLOCKED'] as const).map((s) => (
              <Radio
                key={s}
                name="user-status"
                value={s}
                checked={status === s}
                onChange={() => setStatus(s)}
              >
                {enumLabel(t, 'UserStatus', s)}
              </Radio>
            ))}
          </FieldSet>
        )}
        {user.status !== 'BLOCKED' && status === 'BLOCKED' && (
          <p className="at-field__warning" style={{ margin: 0 }}>
            {t('users.blockNote')}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function LogoCard() {
  const { api, reloadMe } = useSession();
  const me = useMe();
  const scope = useScreenScope();
  const toast = useScreenToast();
  const org = me.organization;
  return (
    <Card>
      <CardHeader title={t('users.logo')} />
      <CardBody>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
          <Avatar
            name={org.name}
            src={org.logoUrl ? withVariant(org.logoUrl, 96) : null}
            size="l"
            shape="square"
          />
          <div style={{ flex: '1 1 16rem', minWidth: 0 }}>
            <ImageUpload
              id="logo-file"
              label={t('field.file')}
              hint={t('users.logoHint')}
              types={LOGO_TYPES}
              maxBytes={LOGO_MAX_BYTES}
              upload={async (file) => {
                const body = new FormData();
                body.append('file', file);
                await call(
                  api.PUT('/organizations/{id}/logo', {
                    params: { path: { id: org.id } },
                    body: body as never,
                  }),
                );
              }}
              onDone={() => {
                toast.done({ tone: 'ok', text: t('users.logoSaved') });
                if (scope.sameSession()) void reloadMe().catch(() => {});
              }}
            />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
