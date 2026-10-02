/** What every handler, view and domain function works with: the configuration and the state. */
import type { MockConfig } from './config.js';
import type { Store } from './store/store.js';

export interface Mock {
  cfg: MockConfig;
  store: Store;
}
