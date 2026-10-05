<script lang="ts">
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDate } from '@agrotrace/i18n';
  import { APPLICATION, ORG_TONE, orgActions, orgTarget, type OrgAction } from '../../app/admin';
  import { call, Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { cache, query } from '../../app/cache.svelte';
  import { dictionary } from '../../app/dictionaries';
  import { DialogAlert } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { isBadListQuery, listGap, listParams, type ListSpec } from '../../app/listState.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Field from '../../ui/Field.svelte';
  import ListChanged from '../../ui/ListChanged.svelte';
  import Page from '../../ui/Page.svelte';
  import PageToolbar from '../../ui/PageToolbar.svelte';
  import Pagination from '../../ui/Pagination.svelte';
  import Select from '../../ui/Select.svelte';
  import Table from '../../ui/Table.svelte';
  import type { Column } from '../../ui/table';
  import OrgEditDialog from './OrgEditDialog.svelte';

  type Org = Schemas['OrganizationAdmin'];
  type Status = Schemas['OrganizationStatus'];
  type OrgType = Schemas['OrganizationType'];

  const SIZE = 20;
  const STACK = 'display: grid; gap: var(--sp-4)';
  const STATUSES: readonly Status[] = ['PENDING', 'MANUAL_CHECK', 'ACTIVE', 'REJECTED', 'SUSPENDED'];
  const TYPES: readonly OrgType[] = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY', 'PLATFORM'];
  const APPLICATIONS = '__applications';
  const SEVERAL = '__several';
  const SPEC: ListSpec = {
    sort: ['createdAt', 'name'],
    enums: { status: STATUSES, type: TYPES },
    patterns: { regionCode: /^[0-9A-Z-]{1,8}$/ },
    texts: ['q'],
  };
  const CONFIRMED: readonly OrgAction[] = ['reject', 'suspend'];

  const screen = screenScope();
  const regions = dictionary('regions');
  const list = listParams(() => '/admin/organizations', SPEC);
  const q = $derived(list.get('q'));
  const status = $derived(list.params.getAll('status'));
  const type = $derived(list.params.getAll('type'));
  const regionCode = $derived(list.get('regionCode'));
  const count = $derived((status.length ? 1 : 0) + (type.length ? 1 : 0) + (regionCode ? 1 : 0));

  const orgs = query(
    () => ['adminOrganizations', list.page, list.params.get('sort'), q, status.join(','), type.join(','), regionCode],
    ([, pageNo, sort, text, statuses, types, region]) =>
      call<Schemas['OrganizationAdminPage']>(
        session.api.GET('/admin/organizations', {
          params: {
            query: {
              page: Number(pageNo),
              size: SIZE,
              ...(sort ? { sort: String(sort) } : {}),
              ...(text ? { q: String(text) } : {}),
              ...(statuses ? { status: String(statuses).split(',') as Status[] } : {}),
              ...(types ? { type: String(types).split(',') as OrgType[] } : {}),
              ...(region ? { regionCode: String(region) } : {}),
            },
          },
        }),
      ),
    { failed: 'orgs.failed' },
  );
  const items = $derived(orgs.data?.items ?? []);
  const gap = $derived(orgs.data ? listGap(orgs.data, list.page, SIZE) : null);
  $effect(() => {
    const data = orgs.data;
    if (data && gap === 'pastEnd') list.clampPage(data.total, SIZE);
  });

  let busyId = $state<string | null>(null);
  const wait = new Countdown();
  $effect(() => () => wait.stop());
  let confirming = $state<{ org: Org; action: OrgAction } | null>(null);
  const failure = new DialogAlert();
  const closeConfirm = () => {
    failure.handOff();
    confirming = null;
  };
  let editing = $state<Org | null>(null);
  let confirmButton = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => wait.left,
    () => confirmButton,
  );

  const reread = () => void cache.invalidate(['adminOrganizations']);

  function describe(e: unknown, org: Org): string {
    if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
      reread();
      return t('orgs.stateChanged', {
        name: org.name,
        status: enumLabel(t, 'OrganizationStatus', String(e.params?.from ?? '')),
      });
    }
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      reread();
      return t('orgs.busy', { name: org.name });
    }
    if (e instanceof ApiProblem && e.status === 404) {
      reread();
      return t('orgs.gone', { name: org.name });
    }
    if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
    return errorText(e);
  }

  async function act(org: Org, action: OrgAction) {
    busyId = org.id;
    failure.clear();
    try {
      const next =
        action === 'approve'
          ? await call<Org>(session.api.POST('/admin/organizations/{id}/approve', { params: { path: { id: org.id } } }))
          : await call<Org>(
              session.api.PATCH('/admin/organizations/{id}', {
                params: { path: { id: org.id } },
                body: { status: orgTarget(action) as 'ACTIVE' | 'REJECTED' | 'SUSPENDED' },
              }),
            );
      if (screen.alive()) confirming = null;
      reread();
      screen.done({ tone: 'ok', text: t(`orgs.done.${action}`, { name: next.name }) });
    } catch (e) {
      if (!screen.alive()) return;
      const text = describe(e, org);
      const stale = e instanceof ApiProblem && (e.code === 'INVALID_TRANSITION' || e.status === 404);
      if (stale) confirming = null;
      if (CONFIRMED.includes(action) && !stale) failure.show(text, errorTone(e));
      else screen.push({ tone: errorTone(e), text });
    } finally {
      busyId = null;
    }
  }

  const columns: Column<Org>[] = [
    { key: 'name', header: t('orgs.name'), primary: true, sortField: 'name' },
    { key: 'status', header: t('orgs.status'), status: true },
    { key: 'head', header: t('orgs.head') },
    { key: 'created', header: t('orgs.createdAt'), sortField: 'createdAt' },
  ];
  const sortOptions = [
    { value: 'createdAt,desc', label: t('orgs.sort.created') },
    { value: 'name,asc', label: t('orgs.sort.name') },
  ];

  const statusValue = $derived(
    status.length === 2 && APPLICATION.every((s) => status.includes(s))
      ? APPLICATIONS
      : status.length === 1
        ? status[0]
        : status.length > 1
          ? SEVERAL
          : '',
  );
  const typeValue = $derived(type.length === 1 ? type[0] : type.length > 1 ? SEVERAL : '');
</script>

{#snippet cell(o: Org, c: Column<Org>)}
  {#if c.key === 'name'}
    <span class="at-table__primary"
      ><span>{o.name}</span><span class="at-table__sub">{t('orgs.inn', { inn: o.inn })}</span><span class="at-table__sub"
        >{t('orgs.typeRegionOf', { type: enumLabel(t, 'OrganizationType', o.type), region: o.region.name })}</span
      ></span
    >
  {:else if c.key === 'status'}
    <Chip tone={ORG_TONE[o.status]}>{enumLabel(t, 'OrganizationStatus', o.status)}</Chip>
  {:else if c.key === 'head'}
    {#if o.head}<span class="at-table__primary"
        ><span>{o.head.fullName}</span><span class="at-table__sub" style="overflow-wrap: anywhere">{o.head.email}</span></span
      >{:else}—{/if}
  {:else}
    {formatLocalDate(o.createdAt, LOCALE)}
  {/if}
{/snippet}

{#snippet rowActions(o: Org)}
  {@const busy = busyId === o.id}
  {#each orgActions(o.status, o.type) as action (action)}
    <Button
      size="s"
      variant={action === 'approve' ? 'primary' : CONFIRMED.includes(action) ? 'danger' : 'secondary'}
      busy={busy && !confirming}
      disabled={wait.left > 0 || (busyId !== null && !busy)}
      aria-label={t(`orgs.actionOf.${action}`, { name: o.name })}
      onclick={() => {
        if (CONFIRMED.includes(action)) {
          failure.clear();
          confirming = { org: o, action };
        } else void userAction(() => act(o, action));
      }}
    >
      {t(`orgs.action.${action}`)}
    </Button>
  {/each}<Button size="s" variant="ghost" aria-label={t('orgs.editOf', { name: o.name })} onclick={() => (editing = o)}>
    {t('orgs.edit')}
  </Button>
{/snippet}

{#snippet filters()}
  <Field id="filter-status" label={t('orgs.status')}>
    <Select
      value={statusValue}
      onchange={(e) =>
        list.set({ status: e.currentTarget.value === APPLICATIONS ? [...APPLICATION] : e.currentTarget.value })}
    >
      <option value="">{t('filters.any')}</option>
      <option value={APPLICATIONS}>{t('orgs.applications')}</option>
      {#if statusValue === SEVERAL}
        <option value={SEVERAL} disabled>{t('filters.several', { count: status.length })}</option>
      {/if}
      {#each STATUSES as s (s)}
        <option value={s}>{enumLabel(t, 'OrganizationStatus', s)}</option>
      {/each}
    </Select>
  </Field>
  <Field id="filter-type" label={t('orgs.type')}>
    <Select value={typeValue} onchange={(e) => list.set({ type: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      {#if typeValue === SEVERAL}
        <option value={SEVERAL} disabled>{t('filters.several', { count: type.length })}</option>
      {/if}
      {#each TYPES as x (x)}
        <option value={x}>{enumLabel(t, 'OrganizationType', x)}</option>
      {/each}
    </Select>
  </Field>
  <Field id="filter-region" label={t('orgs.region')}>
    <Select value={regionCode} onchange={(e) => list.set({ regionCode: e.currentTarget.value })}>
      <option value="">{t('filters.any')}</option>
      {#if regionCode && !regions.data?.some((r) => r.code === regionCode)}
        <option value={regionCode}>{regionCode}</option>
      {/if}
      {#each regions.data ?? [] as r (r.id)}
        <option value={r.code}>{r.name}</option>
      {/each}
    </Select>
  </Field>
{/snippet}

<Page title={t('page.organizations')}>
  <PageToolbar
    search={{ label: t('orgs.search'), placeholder: t('orgs.searchPlaceholder'), value: q, onchange: (text) => list.set({ q: text }) }}
    {count}
    {filters}
  />
  {#if !orgs.data && orgs.failed}
    <AreaFailed
      text={t('orgs.failed')}
      busy={orgs.fetching}
      onretry={() => void userAction(orgs.refetch)}
      onreset={isBadListQuery(orgs.error) ? list.reset : undefined}
    />
  {:else if !orgs.data || gap === 'pastEnd'}
    <AreaLoading />
  {:else if gap === 'changed'}
    <ListChanged busy={orgs.fetching} onreload={() => void userAction(orgs.refetch)} />
  {:else if items.length === 0}
    <Card>
      <Empty
        art="empty-search"
        text={statusValue === APPLICATIONS && !q && count === 1 ? t('orgs.noApplications') : t('empty.search')}
      >
        {#snippet action()}<Button variant="primary" onclick={list.reset}>{t('filters.reset')}</Button>{/snippet}
      </Empty>
    </Card>
  {:else}
    <div aria-busy={orgs.fetching ? 'true' : undefined} style={STACK}>
      <Table
        cards
        caption={t('page.organizations')}
        {columns}
        rows={items}
        rowKey={(o) => o.id}
        sort={list.sort}
        onsort={list.setSort}
        {sortOptions}
        {cell}
        actions={rowActions}
      />
      <Pagination page={list.page} size={SIZE} total={orgs.data.total} hrefFor={list.hrefFor} />
    </div>
  {/if}
  <Dialog
    open={confirming !== null}
    onclose={closeConfirm}
    title={confirming ? t(`orgs.confirm.${confirming.action}.title`, { name: confirming.org.name }) : ''}
  >
    {#snippet actions()}
      <Button variant="ghost" onclick={closeConfirm}>{t('action.cancel')}</Button>
      <Button
        bind:element={confirmButton}
        variant="danger"
        busy={busyId !== null}
        disabled={wait.left > 0}
        onclick={() => {
          const c = confirming;
          if (c) void userAction(() => act(c.org, c.action));
        }}
      >
        {wait.left > 0
          ? t('auth.retryIn', { seconds: wait.left })
          : confirming
            ? t(`orgs.confirm.${confirming.action}.button`)
            : ''}
      </Button>
    {/snippet}
    <div style={STACK}>
      <DialogMessage text={failure.message} />
      <p style="margin: 0">{confirming ? t(`orgs.confirm.${confirming.action}.text`) : ''}</p>
    </div>
  </Dialog>
  {#if editing}
    {@const org = editing}
    <OrgEditDialog
      {org}
      regions={regions.data ?? []}
      onclose={() => (editing = null)}
      onsaved={(next) => {
        editing = null;
        reread();
        screen.done({ tone: 'ok', text: t('orgs.saved', { name: next.name }) });
      }}
      ongone={(e) => {
        const text = describe(e, org);
        editing = null;
        screen.push({ tone: 'danger', text });
      }}
    />
  {/if}
</Page>
