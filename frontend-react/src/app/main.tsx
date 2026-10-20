import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { injectSprite } from '../sprite';
import { AppProviders, createQueryClient } from './providers';
import { buildRoutes, ROUTER_FUTURE } from './router';
import { createSessionCore } from './session';

injectSprite();

const core = createSessionCore();
const router = createBrowserRouter(buildRoutes(core), { future: ROUTER_FUTURE });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders queryClient={createQueryClient()}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AppProviders>
  </StrictMode>,
);
