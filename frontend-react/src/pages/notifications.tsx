import { useEffect, useState } from 'react';
import { Link, matchPath, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiNotification, NotificationPage, UnreadCount } from '@agrotrace/api-client';
import { formatLocalDateTime, notificationMessage } from '@agrotrace/i18n';
import { canAccess, type Viewer } from '../app/access';
import { applyProblem, call, useFormAlert } from '../app/api';
import { LOCALE, t } from '../app/i18n';
import { CABINET_ROUTES } from '../app/routes';
import { useMe, useSession } from '../app/session';
import { useSetUnread, useUnread } from '../app/sse';
import { Button, ButtonLink, Card, Chip, Empty, Page, Pagination, Table, Tabs, type Column } from '../ui';

const SIZE = 20;
type Tab = 'all' | 'unread';

function targets(n: ApiNotification): string[] {
  const p = (n.payload ?? {}) as Record<string, unknown>;
  const at = (...parts: unknown[]) =>
    parts.every((x) => typeof x === 'string' && x !== '') ? parts.join('') : null;
  const list: (string | null)[] = (() => {
    switch (n.type) {
      case 'LAB_ASSIGNED':
      case 'LAB_OVERDUE':
        return [at('/lab/tests/', p.labTestId), at('/batches/', p.batchId)];
      case 'LAB_RESULT':
        return [at('/batches/', p.batchId, '?tab=tests'), at('/lab/tests/', p.labTestId)];
      case 'WAYBILL_INCOMING':
        return [at('/waybills/', p.waybillId)];
      case 'RECALL':
        return [at('/recalls/', p.recallId), at('/batches/', p.sourceBatchId)];
      case 'RECALL_TASK':
        return ['/recall-tasks', at('/recalls/', p.recallId), at('/batches/', p.batchId)];
      case 'OVERDUE':
        return [at('/recalls/', p.recallId), '/recall-tasks'];
      case 'COMPLAINT':
        return [at('/complaints/', p.complaintId), at('/batches/', p.batchId)];
      default:
        return [];
    }
  })();
  return list.filter((x): x is string => x !== null);
}

export function linkFor(n: ApiNotification, viewer: Viewer): string | null {
  for (const href of targets(n)) {
    const path = href.split('?')[0]!;
    const route = CABINET_ROUTES.find((r) => matchPath(r.path, path));
    if (route && canAccess(viewer, route.access)) return href;
  }
  return null;
}

const text = (n: ApiNotification, part: 'title' | 'body') =>
  notificationMessage(n.type, (n.payload ?? {}) as Record<string, unknown>, part, t);

export function NotificationsPage() {
  const { api } = useSession();
  const me = useMe();
  const unread = useUnread();
  const setUnread = useSetUnread();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'unread' ? 'unread' : 'all';
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [tab, page]);
  const [marking, setMarking] = useState<'ids' | 'all' | null>(null);
  const alert = useFormAlert();

  const list = useQuery({
    queryKey: ['notifications', { tab, page }],
    meta: { failed: 'notifications.failed' },
    queryFn: () =>
      call<NotificationPage>(
        api.GET('/notifications', {
          params: {
            query: { page, size: SIZE, sort: 'seq,desc', ...(tab === 'unread' ? { isRead: false } : {}) },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];

  const hrefFor = (p: number) => {
    const q = new URLSearchParams();
    if (tab === 'unread') q.set('tab', 'unread');
    if (p > 1) q.set('page', String(p));
    const s = q.toString();
    return `/notifications${s ? `?${s}` : ''}`;
  };

  const selectTab = (id: string) => {
    setSelected(new Set());
    setParams(id === 'unread' ? { tab: 'unread' } : {});
  };

  const newestSeq = async (): Promise<number> => {
    if (tab === 'all' && page === 1 && items[0]) return items[0].seq;
    const first = await call<NotificationPage>(
      api.GET('/notifications', { params: { query: { page: 1, size: 1, sort: 'seq,desc' } } }),
    );
    return first.items[0]?.seq ?? Math.max(...items.map((n) => n.seq));
  };

  const mark = async (kind: 'ids' | 'all') => {
    if (kind === 'all' && items.length === 0) return;
    alert.clear();
    setMarking(kind);
    try {
      const body = kind === 'ids' ? { ids: [...selected] } : { upToSeq: await newestSeq() };
      const res = await call<UnreadCount>(api.POST('/notifications/read', { body }));
      setUnread(res.count);
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch (e) {
      applyProblem(e, { alert: alert.show });
    } finally {
      setMarking(null);
    }
  };

  const columns: Column<ApiNotification>[] = [
    {
      key: 'title',
      header: t('notifications.column'),
      primary: true,
      cell: (n) => {
        const href = linkFor(n, me);
        return (
          <span className="at-table__primary">
            {href ? <Link to={href}>{text(n, 'title')}</Link> : <span>{text(n, 'title')}</span>}
            <span className="at-table__sub">{text(n, 'body')}</span>
          </span>
        );
      },
    },
    {
      key: 'state',
      header: t('notifications.status'),
      status: true,
      cell: (n) => (
        <Chip tone={n.isRead ? 'neutral' : 'move'}>
          {t(n.isRead ? 'notifications.read' : 'notifications.new')}
        </Chip>
      ),
    },
    {
      key: 'createdAt',
      header: t('notifications.received'),
      cell: (n) => <time dateTime={n.createdAt}>{formatLocalDateTime(n.createdAt, LOCALE)}</time>,
    },
  ];

  const content = () => {
    if (!list.data && list.isError)
      return (
        <Card>
          <Empty
            art="empty-search"
            text={t('notifications.failed')}
            action={
              <Button variant="primary" busy={list.isFetching} onClick={() => void list.refetch()}>
                {t('action.retry')}
              </Button>
            }
          />
        </Card>
      );
    if (!list.data)
      return (
        <div aria-busy="true" style={{ display: 'grid', gap: 'var(--sp-3)' }}>
          <span className="at-visually-hidden">{t('shell.loading')}</span>
          <span className="at-skeleton" data-shape="block"></span>
          <span className="at-skeleton" data-shape="block"></span>
        </div>
      );
    if (items.length === 0)
      return (
        <Card>
          {tab === 'unread' ? (
            <Empty
              art="empty-notifications"
              text={t('notifications.emptyUnread')}
              action={
                <Button variant="primary" onClick={() => selectTab('all')}>
                  {t('notifications.showAll')}
                </Button>
              }
            />
          ) : (
            <Empty
              art="empty-notifications"
              text={t('empty.notifications')}
              action={
                <ButtonLink variant="primary" to="/">
                  {t('action.home')}
                </ButtonLink>
              }
            />
          )}
        </Card>
      );
    return (
      <div aria-busy={list.isFetching ? 'true' : undefined} style={{ display: 'grid', gap: 'var(--sp-4)' }}>
        <Table
          cards
          caption={t('page.notifications')}
          columns={columns}
          rows={items}
          rowKey={(n) => n.id}
          selection={{
            selected,
            onChange: setSelected,
            allLabel: t('notifications.selectAll'),
            rowLabel: (n) => t('notifications.select', { title: text(n, 'title') }),
          }}
        />
        <Pagination page={page} size={SIZE} total={list.data.total} hrefFor={hrefFor} />
      </div>
    );
  };

  return (
    <Page
      title={t('page.notifications')}
      actions={
        <>
          {selected.size > 0 && (
            <Button busy={marking === 'ids'} onClick={() => void mark('ids')}>
              {t('action.markRead')}
            </Button>
          )}
          <Button
            variant="primary"
            busy={marking === 'all'}
            disabled={items.length === 0 || (unread === 0 && !items.some((n) => !n.isRead))}
            onClick={() => void mark('all')}
          >
            {t('action.markAllRead')}
          </Button>
        </>
      }
    >
      <Tabs
        label={t('notifications.tabs')}
        tabs={[
          { id: 'all', label: t('notifications.all') },
          { id: 'unread', label: t('notifications.unread'), count: unread > 0 ? unread : undefined },
        ]}
        selected={tab}
        onSelect={selectTab}
        panel={() => content()}
      />
    </Page>
  );
}
