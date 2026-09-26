import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
        const key = typeof query.meta?.failed === 'string' ? query.meta.failed : 'ui.refreshFailed';
        const e = event.action.error;
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
