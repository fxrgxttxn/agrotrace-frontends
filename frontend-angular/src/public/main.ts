import { bootstrapApplication } from '@angular/platform-browser';
import { provideExperimentalZonelessChangeDetection } from '@angular/core';
import alert from '@agrotrace/design-system/icons/alert.svg';
import check from '@agrotrace/design-system/icons/check.svg';
import clock from '@agrotrace/design-system/icons/clock.svg';
import { injectIcons } from './sprite';
import { PublicApp } from './public-app';

// Public QR pages (/p/:publicCode, /p/:publicCode/complaint): a separate light build with no cabinet code (spec §9.6),
// no zone.js (zoneless change detection), ≤ 60 KB JS gzip (scripts/public-budget.mjs fails the build otherwise). Only
// the icons it shows.
injectIcons({ alert, check, clock });

bootstrapApplication(PublicApp, { providers: [provideExperimentalZonelessChangeDetection()] }).catch(
  (e: unknown) => console.error(e),
);
