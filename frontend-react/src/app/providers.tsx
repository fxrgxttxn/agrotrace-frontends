import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiProblem } from '@agrotrace/api-client';
import { ToastProvider } from '../ui';

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

export function AppProviders({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
