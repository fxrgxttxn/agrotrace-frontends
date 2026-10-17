<script lang="ts">
  import { onDestroy } from 'svelte';
  import { page } from '$app/state';
  import type { ApiNotification, NotificationPage, UnreadCount } from '@agrotrace/api-client';
  import { formatLocalDateTime } from '@agrotrace/i18n';
  import { call } from '../app/api.svelte';
  import { cache, query, screenAlive } from '../app/cache.svelte';
  import { applyProblem, FormAlert } from '../app/forms.svelte';
  import { goto } from '../app/goto';
  import { LOCALE, t } from '../app/i18n';
  import { userAction } from '../app/focusRescue';
  import { live } from '../app/live.svelte';
  import { withBase } from '../app/paths';
  import { session } from '../app/session.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import Chip from '../ui/Chip.svelte';
  import Empty from '../ui/Empty.svelte';
  import Page from '../ui/Page.svelte';
  import Pagination from '../ui/Pagination.svelte';
  import Table from '../ui/Table.svelte';
  import type { Column } from '../ui/table';
  import Tabs from '../ui/Tabs.svelte';
  import { linkFor, notificationText as text } from './notifications';

  const SIZE = 20;
  type Tab = 'all' | 'unread';

  const tab: Tab = $derived(page.url.searchParams.get('tab') === 'unread' ? 'unread' : 'all');
  const pageNo = $derived(Math.max(1, Math.floor(Number(page.url.searchParams.get('page'))) || 1));

  const list = query(
    () => ['notifications', tab, pageNo],
    ([, keyTab, keyPage]) =>
      call<NotificationPage>(
        session.api.GET('/notifications', {
          params: {
            query: {
              page: Number(keyPage),
              size: SIZE,
              sort: 'seq,desc',
              ...(keyTab === 'unread' ? { isRead: false } : {}),
            },
          },
        }),
      ),
    { failed: 'notifications.failed' },
  );
  const alive = screenAlive();
  const items = $derived(list.data?.items ?? []);

  let selected: ReadonlySet<string> = $state.raw(new Set());
  $effect.pre(() => {
    void tab;
    void pageNo;
    selected = new Set();
  });

  let marking: 'ids' | 'all' | null = $state(null);
  const alert = new FormAlert();
  onDestroy(() => alert.clear());

  function hrefFor(p: number): string {
    const q = new URLSearchParams();
    if (tab === 'unread') q.set('tab', 'unread');
    if (p > 1) q.set('page', String(p));
    const s = q.toString();
    return `/notifications${s ? `?${s}` : ''}`;
  }

  function selectTab(id: string) {
    selected = new Set();
    void goto(id === 'unread' ? '/notifications?tab=unread' : '/notifications', { keepFocus: true, noScroll: true });
  }

  async function newestSeq(): Promise<number> {
    if (tab === 'all' && pageNo === 1 && items[0]) return items[0].seq;
    const first = await call<NotificationPage>(
      session.api.GET('/notifications', { params: { query: { page: 1, size: 1, sort: 'seq,desc' } } }),
    );
    return first.items[0]?.seq ?? Math.max(...items.map((n) => n.seq));
  }

  async function mark(kind: 'ids' | 'all') {
    if (kind === 'all' && items.length === 0) return;
    alert.clear();
    marking = kind;
    const generation = cache.generation;
    try {
      const body = kind === 'ids' ? { ids: [...selected] } : { upToSeq: await newestSeq() };
      const res = await call<UnreadCount>(session.api.POST('/notifications/read', { body }));
      if (cache.generation !== generation) return;
      if (alive()) {
        live.unread = res.count;
        selected = new Set();
      }
      void cache.invalidate(['notifications']);
    } catch (err) {
      if (alive()) applyProblem(err, { alert: alert.show });
    } finally {
      marking = null;
    }
  }

  const columns: Column<ApiNotification>[] = [
    { key: 'title', header: t('notifications.column'), primary: true },
    { key: 'state', header: t('notifications.status'), status: true },
    { key: 'createdAt', header: t('notifications.received') },
  ];
</script>

{#snippet cell(n: ApiNotification, c: Column<ApiNotification>)}
  {#if c.key === 'title'}
    {@const href = session.me ? linkFor(n, session.me) : null}
    <span class="at-table__primary"
      >{#if href}<a href={withBase(href)}>{text(n, 'title')}</a>{:else}<span>{text(n, 'title')}</span>{/if}<span
        class="at-table__sub">{text(n, 'body')}</span
      ></span
    >
  {:else if c.key === 'state'}
    <Chip tone={n.isRead ? 'neutral' : 'move'}>{t(n.isRead ? 'notifications.read' : 'notifications.new')}</Chip>
  {:else}
    <time datetime={n.createdAt}>{formatLocalDateTime(n.createdAt, LOCALE)}</time>
  {/if}
{/snippet}

<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
{#snippet content(_tab: string)}
  {#if !list.data && list.failed}
    <Card>
      <Empty art="empty-search" text={t('notifications.failed')}>
        {#snippet action()}
          <Button variant="primary" busy={list.fetching} onclick={() => void userAction(list.refetch)}>{t('action.retry')}</Button>
        {/snippet}
      </Empty>
    </Card>
  {:else if !list.data}
    <div aria-busy="true" style="display: grid; gap: var(--sp-3)">
      <span class="at-visually-hidden">{t('shell.loading')}</span>
      <span class="at-skeleton" data-shape="block"></span>
      <span class="at-skeleton" data-shape="block"></span>
    </div>
  {:else if items.length === 0}
    <Card>
      {#if tab === 'unread'}
        <Empty art="empty-notifications" text={t('notifications.emptyUnread')}>
          {#snippet action()}
            <Button variant="primary" onclick={() => selectTab('all')}>{t('notifications.showAll')}</Button>
          {/snippet}
        </Empty>
      {:else}
        <Empty art="empty-notifications" text={t('empty.notifications')}>
          {#snippet action()}<Button variant="primary" href="/">{t('action.home')}</Button>{/snippet}
        </Empty>
      {/if}
    </Card>
  {:else}
    <div aria-busy={list.fetching ? 'true' : undefined} style="display: grid; gap: var(--sp-4)">
      <Table
        cards
        caption={t('page.notifications')}
        {columns}
        rows={items}
        rowKey={(n) => n.id}
        selection={{
          selected,
          onchange: (next) => (selected = next),
          allLabel: t('notifications.selectAll'),
          rowLabel: (n) => t('notifications.select', { title: text(n, 'title') }),
        }}
        {cell}
      />
      <Pagination page={pageNo} size={SIZE} total={list.data.total} {hrefFor} />
    </div>
  {/if}
{/snippet}

<Page title={t('page.notifications')}>
  {#snippet actions()}
    {#if selected.size > 0}
      <Button busy={marking === 'ids'} onclick={() => void userAction(() => mark('ids'))}>{t('action.markRead')}</Button>
    {/if}
    <Button
      variant="primary"
      busy={marking === 'all'}
      disabled={items.length === 0 || (live.unread === 0 && !items.some((n) => !n.isRead))}
      onclick={() => void userAction(() => mark('all'))}>{t('action.markAllRead')}</Button
    >
  {/snippet}
  <Tabs
    label={t('notifications.tabs')}
    tabs={[
      { id: 'all', label: t('notifications.all') },
      { id: 'unread', label: t('notifications.unread'), count: live.unread > 0 ? live.unread : undefined },
    ]}
    selected={tab}
    onselect={selectTab}
    panel={content}
  />
</Page>
