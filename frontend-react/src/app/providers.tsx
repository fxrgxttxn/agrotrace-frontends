import { isCancelledError, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { ApiProblem } from '@agrotrace/api-client';
import { ToastProvider, useToast } from '../ui';
import { t } from './i18n';

/** Server data (spec §9.2: TanStack Query). A 4xx is an answer, not a hiccup: only transient failures are retried. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, error) =>
          count < 2 && !(error instanceof ApiProblem && error.status >= 400 && error.status < 500),
      },
      mutations: { retry: false },
    },
  });
}

/** Stale-while-revalidate (ruling FM24): a refetch of data already on screen that fails (after its retries) keeps the
 * rows and says so in a toast — the screen's own «… не загрузились.» text (`meta.failed` of the query). A first load
 * that fails is the screen's own failed state, not a toast. */
function RefetchFailures({ client }: { client: QueryClient }) {
  const toast = useToast();
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const query = event.query;
        if (query.state.data === undefined || query.getObserversCount() === 0) return;
        const e = event.action.error;
        // FM29: a cancellation (a session that ended cancels its queries) and a 401 (the auth flow already acted:
        // refresh, or the login screen) are not failures to report; nor is a query of an ended session (cleared).
        if (isCancelledError(e) || (e instanceof DOMException && e.name === 'AbortError')) return;
        if (e instanceof ApiProblem && e.status === 401) return;
        if (client.getQueryCache().get(query.queryHash) !== query) return;
        const key = typeof query.meta?.failed === 'string' ? query.meta.failed : 'ui.refreshFailed';
        toast.push({
          tone: e instanceof ApiProblem && e.status === 429 ? 'attention' : 'danger',
          text: t(key),
        });
      }),
    [client, toast],
  );
  return null;
}

export function AppProviders({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RefetchFailures client={queryClient} />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}
