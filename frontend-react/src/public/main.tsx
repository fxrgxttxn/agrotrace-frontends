import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { injectSprite } from '../sprite';
import { PublicApp } from './PublicApp';

// Public QR pages (/p/:publicCode, /p/:publicCode/complaint): a separate light entry with no cabinet code (spec §9.6,
// Plan 2 task 8 fills it in and keeps it ≤ 60 KB JS gzip).
injectSprite();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PublicApp path={location.pathname} />
  </StrictMode>,
);
