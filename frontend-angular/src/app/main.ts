import 'zone.js';
import { bootstrapApplication } from '@angular/platform-browser';
import { injectSprite } from '../sprite';
import { AppComponent } from './app.component';
import { appConfig } from './app.config';
import { DEV_ROUTES } from './dev-routes';

// The cabinet app (everything but /p/*). zone.js is loaded here, not as a global polyfill: the public entry runs
// without it.
injectSprite();

bootstrapApplication(AppComponent, appConfig(DEV_ROUTES)).catch((e: unknown) => console.error(e));
