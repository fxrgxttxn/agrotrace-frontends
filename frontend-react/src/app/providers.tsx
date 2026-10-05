import { isCancelledError, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { ApiProblem } from '@agrotrace/api-client';
import { ToastProvider, useToast } from '../ui';
import { t } from './i18n';

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

function RefetchFailures({ client }: { client: QueryClient }) {
  const toast = useToast();
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const query = event.query;
        if (query.state.data === undefined || query.getObserversCount() === 0) return;
        const e = event.action.error;
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
