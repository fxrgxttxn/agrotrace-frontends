<script lang="ts">
  import { untrack } from 'svelte';
  import { withVariant, type Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { USER_TONE } from '../../app/admin';
  import type { Role } from '../../app/access';
  import { call } from '../../app/api.svelte';
  import { cache, query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import { isBadListQuery, listGap, listParams, type ListSpec } from '../../app/listState.svelte';
  import OrgPicker from '../../app/OrgPicker.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Avatar from '../../ui/Avatar.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Field from '../../ui/Field.svelte';
  import ListChanged from '../../ui/ListChanged.svelte';
  import Page from '../../ui/Page.svelte';
  import PageToolbar from '../../ui/PageToolbar.svelte';
  import Pagination from '../../ui/Pagination.svelte';
  import Select from '../../ui/Select.svelte';
  import Table from '../../ui/Table.svelte';
  import type { Column } from '../../ui/table';
  import InviteDialog from './InviteDialog.svelte';
  import LogoCard from './LogoCard.svelte';
  import UserEditDialog from './UserEditDialog.svelte';

  type User = Schemas['User'];
  type UserStatus = Schemas['UserStatus'];

  let { admin }: { admin: boolean } = $props();

  const SIZE = 20;
  const STACK = 'display: grid; gap: var(--sp-4)';
  const GAP = 'display: grid; gap: var(--sp-5)';
  const STATUSES: readonly UserStatus[] = ['INVITED', 'ACTIVE', 'BLOCKED'];
  const ROLES: readonly Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
  const ADMIN_SPEC: ListSpec = {
    sort: ['fullName', 'email', 'createdAt'],
    enums: { status: STATUSES, role: ROLES },
    uuids: ['organizationId'],
    texts: ['q'],
  };
  const STAFF_SPEC: ListSpec = { sort: ['fullName', 'email', 'createdAt'], enums: { status: STATUSES }, texts: ['q'] };

  const screen = screenScope();
  const me = $derived(session.me!);
  const path = untrack(() => (admin ? '/admin/users' : '/org/staff'));
  const list = listParams(() => path, untrack(() => (admin ? ADMIN_SPEC : STAFF_SPEC)));
  const q = $derived(list.get('q'));
  const status = $derived(list.get('status'));
  const role = $derived(list.get('role'));
  const organizationId = $derived(list.get('organizationId'));
  const count = $derived([status, role, organizationId].filter(Boolean).length);
  let inviting = $state(false);
  let editing = $state<User | null>(null);

  const users = query(
    () => ['users', admin, list.page, list.params.get('sort'), q, status, role, organizationId],
    ([, , pageNo, sort, text, st, r, org]) =>
      call<Schemas['UserPage']>(
        session.api.GET('/users', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(st ? { status: st as UserStatus } : {}),
              ...(r ? { role: r as Role } : {}),
              ...(org ? { organizationId: String(org) } : {}),
            },
          },
        }),
      ),
    { failed: 'users.failed' },
  );
  const items = $derived(users.data?.items ?? []);
  const gap = $derived(users.data ? listGap(users.data, list.page, SIZE) : null);
  $effect(() => {
    const data = users.data;
    if (data && gap === 'pastEnd') list.clampPage(data.total, SIZE);
  });

  const reread = () => void cache.invalidate(['users']);

  const columns = $derived<Column<User>[]>([
    { key: 'user', header: t('users.user'), primary: true, sortField: 'fullName' },
    { key: 'status', header: t('users.status'), status: true },
    ...(admin ? [{ key: 'org', header: t('users.organization'), text: (u: User) => u.organization.name }] : []),
    { key: 'role', header: t('users.role') },
  ]);
  const sortOptions = [
    { value: 'fullName,asc', label: t('users.sort.name') },
    { value: 'email,asc', label: t('users.sort.email') },
    { value: 'createdAt,desc', label: t('users.sort.created') },
  ];
</script>

{#snippet cell(u: User, c: Column<User>)}
  {#if c.key === 'user'}
    <span style="display: flex; gap: var(--sp-3); align-items: center; min-width: 0"
      ><Avatar name={u.fullName} src={u.avatarUrl ? withVariant(u.avatarUrl, 96) : null} size="s" decorative /><span
        class="at-table__primary"><span>{u.fullName}</span><span class="at-table__sub">{u.email}</span></span
      ></span
    >
  {:else if c.key === 'status'}
    <Chip tone={USER_TONE[u.status]}>{enumLabel(t, 'UserStatus', u.status)}</Chip>
  {:else if c.key === 'org'}
    {u.organization.name}
  {:else}
    <span class="at-table__primary"
      ><span>{u.roles.map((r) => enumLabel(t, 'RoleCode', r)).join(', ')}</span>{#if u.isOrgAdmin}<span
          class="at-table__sub">{t('users.head')}</span
        >{/if}</span
    >
  {/if}
{/snippet}

{#snippet rowActions(u: User)}
  {#if u.id !== me.id}
    <Button size="s" aria-label={t('users.editOf', { name: u.fullName })} onclick={() => (editing = u)}>
      {t('users.edit')}
    </Button>
  {/if}
{/snippet}

{#snippet filters()}
  <Field id="filter-status" label={t('users.status')}>
    <Select value={status} onchange={(e) => list.set({ status: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      {#each STATUSES as s (s)}
        <option value={s}>{enumLabel(t, 'UserStatus', s)}</option>
      {/each}
    </Select>
  </Field>
  {#if admin}
    <Field id="filter-role" label={t('users.role')}>
      <Select value={role} onchange={(e) => list.set({ role: e.currentTarget.value })}>
        <option value="">{t('filters.any')}</option>
        {#each ROLES as r (r)}
          <option value={r}>{enumLabel(t, 'RoleCode', r)}</option>
        {/each}
      </Select>
    </Field>
    <OrgPicker
      id="filter-org"
      label={t('users.organization')}
      value={organizationId}
      onchange={(id) => list.set({ organizationId: id })}
    />
  {/if}
{/snippet}

{#snippet pageActions()}
  <Button variant="primary" icon="plus" onclick={() => (inviting = true)}>{t('action.invite')}</Button>
{/snippet}

<Page title={admin ? t('page.users') : t('page.staff')} actions={pageActions}>
  <div style={GAP}>
    {#if !admin}<LogoCard />{/if}
    <div style={STACK}>
      <PageToolbar
        search={{ label: t('users.search'), placeholder: t('users.searchPlaceholder'), value: q, onchange: (text) => list.set({ q: text }) }}
        {count}
        {filters}
      />
      {#if !users.data && users.failed}
        <AreaFailed
          text={t('users.failed')}
          busy={users.fetching}
          onretry={() => void userAction(users.refetch)}
          onreset={isBadListQuery(users.error) ? list.reset : undefined}
        />
      {:else if !users.data || gap === 'pastEnd'}
        <AreaLoading />
      {:else if gap === 'changed'}
        <ListChanged busy={users.fetching} onreload={() => void userAction(users.refetch)} />
      {:else if items.length === 0}
        <Card>
          {#if q || count}
            <Empty art="empty-search" text={t('empty.search')}>
              {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
            </Empty>
          {:else}
            <Empty art="empty-search" text={t('empty.users')} />
          {/if}
        </Card>
      {:else}
        <div aria-busy={users.fetching ? 'true' : undefined} style={STACK}>
          <Table
            cards
            caption={admin ? t('page.users') : t('page.staff')}
            {columns}
            rows={items}
            rowKey={(u) => u.id}
            sort={list.sort}
            onsort={list.setSort}
            {sortOptions}
            {cell}
            actions={rowActions}
          />
          <Pagination page={list.page} size={SIZE} total={users.data.total} hrefFor={list.hrefFor} />
        </div>
      {/if}
    </div>
  </div>
  {#if inviting}
    <InviteDialog
      {admin}
      onclose={() => (inviting = false)}
      ondone={(u) => {
        inviting = false;
        reread();
        screen.done({ tone: 'ok', text: t('users.invited', { email: u.email }) });
      }}
    />
  {/if}
  {#if editing}
    <UserEditDialog
      user={editing}
      onclose={() => (editing = null)}
      ondone={(u) => {
        editing = null;
        reread();
        screen.done({ tone: 'ok', text: t('users.saved', { name: u.fullName }) });
      }}
      onstale={(text) => {
        editing = null;
        reread();
        screen.push({ tone: 'danger', text });
      }}
    />
  {/if}
</Page>
