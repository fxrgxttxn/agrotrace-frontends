import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { injectSprite } from '../sprite';
import { AppProviders, createQueryClient } from './providers';
import { buildRoutes } from './router';
import { createSessionCore } from './session';

injectSprite();

const core = createSessionCore();
const router = createBrowserRouter(buildRoutes(core), {
  future: {
    v7_relativeSplatPath: true,
    v7_fetcherPersist: true,
    v7_normalizeFormMethod: true,
    v7_partialHydration: true,
    v7_skipActionErrorRevalidation: true,
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders queryClient={createQueryClient()}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AppProviders>
  </StrictMode>,
);
