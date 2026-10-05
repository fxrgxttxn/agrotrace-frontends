import { bootstrapApplication } from '@angular/platform-browser';
import { provideExperimentalZonelessChangeDetection } from '@angular/core';
import alert from '@agrotrace/design-system/icons/alert.svg';
import check from '@agrotrace/design-system/icons/check.svg';
import clock from '@agrotrace/design-system/icons/clock.svg';
import { injectIcons } from './sprite';
import { PublicApp } from './public-app';

injectIcons({ alert, check, clock });

bootstrapApplication(PublicApp, { providers: [provideExperimentalZonelessChangeDetection()] }).catch(
  (e: unknown) => console.error(e),
);
