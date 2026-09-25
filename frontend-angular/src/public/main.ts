import { bootstrapApplication } from '@angular/platform-browser';
import { provideExperimentalZonelessChangeDetection } from '@angular/core';
import { injectSprite } from '../sprite';
import { PublicApp } from './public-app';

// Public QR pages (/p/:publicCode, /p/:publicCode/complaint): a separate light entry with no cabinet code (spec §9.6)
// and no zone.js (zoneless change detection).
injectSprite();

bootstrapApplication(PublicApp, { providers: [provideExperimentalZonelessChangeDetection()] }).catch(
  (e: unknown) => console.error(e),
);
