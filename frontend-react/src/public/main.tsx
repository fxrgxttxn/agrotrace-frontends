import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import alert from '@agrotrace/design-system/icons/alert.svg?raw';
import check from '@agrotrace/design-system/icons/check.svg?raw';
import clock from '@agrotrace/design-system/icons/clock.svg?raw';
import { injectIcons } from '../spriteSubset';
import { PublicApp } from './PublicApp';

// Public QR pages (/p/:publicCode, /p/:publicCode/complaint): a separate light entry with no cabinet code (spec §9.6),
// ≤ 60 KB JS gzip (vite-plugins/publicBudget.ts fails the build otherwise). Only the icons it shows.
injectIcons({ alert, check, clock });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PublicApp />
  </StrictMode>,
);
