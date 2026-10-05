import { delay, http, type HttpHandler } from 'msw';
import { memoryCounters, storageCounters, webLock, type BlobStore, type CrossTabLock, type MockConfig, type MockMail, type RateCounters } from './config.js';
import { renderGenerated } from './domain/documents.js';
import { runSchedulers } from './domain/scheduler.js';
import { totpNow } from './domain/tokens.js';
import { createRouter } from './http/router.js';
import type { Handler } from './http/context.js';
import { adminHandlers } from './modules/admin.js';
import { analyticsHandlers } from './modules/analytics.js';
import { authHandlers } from './modules/auth.js';
import { batchesHandlers } from './modules/batches.js';
import { complaintsHandlers } from './modules/complaints.js';
import { dictionariesHandlers } from './modules/dictionaries.js';
import { fieldsHandlers } from './modules/fields.js';
import { filesHandlers } from './modules/files.js';
import { labHandlers } from './modules/lab.js';
import { EventHub, notificationsHandlers } from './modules/notifications.js';
import { organizationsHandlers } from './modules/organizations.js';
import { processingHandlers } from './modules/processing.js';
import { profileHandlers } from './modules/profile.js';
import { publicHandlers } from './modules/public.js';
import { recallsHandlers } from './modules/recalls.js';
import { usersHandlers } from './modules/users.js';
import { waybillsHandlers } from './modules/waybills.js';
import type { AssetLoader } from './render/documents.js';
import type { Mock } from './runtime.js';
import { indexedDbBlobs, SharedState, VERSION_KEY } from './store/persist.js';
import { buildSeed } from './store/seed.js';
import type { Store } from './store/store.js';

export { DEMO_PASSWORD } from './store/seed.js';
export type { BlobStore, CrossTabLock, MockMail, RateCounters } from './config.js';
export { memoryCounters } from './config.js';
export { solveChallenge } from './domain/altcha.js';
export { totpNow } from './domain/tokens.js';

export interface MockApiOptions {
  now?: () => Date | number;
  delayMs?: number;
  persist?: false | 'session' | 'local' | Storage;
  blobStore?: BlobStore | null;
  lock?: CrossTabLock | null;
  verifyPersistence?: boolean;
  counters?: RateCounters;
  publicBaseUrl?: string;
  loadAsset?: AssetLoader;
  totpUsers?: Record<string, string>;
  rateLimits?: boolean;
  telegramBot?: string | null;
  onMail?: (mail: MockMail) => void;
  lifecycle?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

export interface MockApi {
  handlers: HttpHandler[];
  ready: Promise<void>;
  readonly store: Store;
  handle(request: Request): Promise<Response>;
  reset(): Promise<void>;
  mailbox: MockMail[];
  totp(email: string): string;
  linkTelegram(code: string): Promise<boolean>;
  readonly openStreams: number;
  readonly persistError: unknown;
  dispose(): void;
}

const defaultLoadAsset: AssetLoader = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

let warnedNoLocks = false;
export function warnNoLocks(): void {
  if (warnedNoLocks) return;
  warnedNoLocks = true;
  console.warn('[mock-api] navigator.locks is not available: tabs of this origin are not serialized and concurrent writes of two tabs can overwrite each other');
}

function storageOf(persist: MockApiOptions['persist']): Storage | null {
  if (persist === false) return null;
  if (typeof persist === 'object') return persist;
  const g = globalThis as { sessionStorage?: Storage; localStorage?: Storage };
  try {
    return (persist === 'session' ? g.sessionStorage : g.localStorage) ?? null;
  } catch {
    return null;
  }
}

export function createMockApi(options: MockApiOptions = {}): MockApi {
  const clock = options.now ?? (() => Date.now());
  const now = (): number => {
    const v = clock();
    return typeof v === 'number' ? v : v.getTime();
  };
  const mailbox: MockMail[] = [];
  const g = globalThis as {
    location?: { origin: string };
    addEventListener?: (t: string, f: (e: { key: string | null }) => void) => void;
    removeEventListener?: (t: string, f: (e: { key: string | null }) => void) => void;
  };
  const storage = storageOf(options.persist);
  const blobs = options.blobStore === undefined ? (storage ? indexedDbBlobs() : null) : options.blobStore;
  const cfg: MockConfig = {
    now,
    publicBaseUrl: options.publicBaseUrl ?? g.location?.origin ?? 'http://localhost',
    loadAsset: options.loadAsset ?? defaultLoadAsset,
    totpUsers: options.totpUsers ?? {},
    rateLimits: options.rateLimits ?? true,
    secret: 'agrotrace-mock-api-secret',
    telegramBot: options.telegramBot === undefined ? 'agrotrace_bot' : options.telegramBot,
    onMail: (mail) => {
      mailbox.push(mail);
      options.onMail?.(mail);
    },
    blobs,
    counters: options.counters ?? (storage ? storageCounters(storage) : memoryCounters()),
  };
  const shared = storage ? new SharedState(storage, blobs, now) : null;
  let persistError: unknown = null;

  const fresh = (): Store => buildSeed(cfg).store;
  const m: Mock = { cfg, store: shared?.loadIfChanged() ?? fresh() };
  const hub = new EventHub(() => m.store);

  const handlers: Record<string, Handler> = {
    ...authHandlers,
    ...profileHandlers,
    ...usersHandlers,
    ...organizationsHandlers,
    ...filesHandlers,
    ...fieldsHandlers,
    ...batchesHandlers,
    ...processingHandlers,
    ...waybillsHandlers,
    ...labHandlers,
    ...recallsHandlers,
    ...complaintsHandlers,
    ...analyticsHandlers,
    ...adminHandlers,
    ...dictionariesHandlers,
    ...publicHandlers,
    ...notificationsHandlers(hub),
  };

  const readThrough = async (): Promise<void> => {
    const next = shared?.loadIfChanged();
    if (!next) return;
    const seenSeq = m.store.seq.notification;
    for (const f of next.t.files) {
      const old = f.regen ? m.store.get('files', f.id) : undefined;
      if (old && old.sha256 === f.sha256 && old.content.type === 'bytes' && old.content.data.length > 0) f.content = old.content;
    }
    const reset = next.epoch !== m.store.epoch;
    m.store = next;
    hub.attach(next);
    await renderGenerated(cfg, next);
    if (reset) hub.closeAll();
    else hub.deliverFrom(seenSeq);
  };

  const save = async (): Promise<void> => {
    if (!shared) return;
    try {
      await shared.save(m.store, options.verifyPersistence ?? false);
      persistError = null;
    } catch (e) {
      if (options.verifyPersistence) throw e;
      persistError = e;
      console.error('[mock-api] the state could not be persisted; other tabs will not see this change', e);
    }
  };

  let leaving = false;
  const lifecycle = options.lifecycle !== undefined ? options.lifecycle : g.addEventListener ? (globalThis as unknown as EventTarget) : null;
  const onPageHide = (): void => void (leaving = true);
  const onPageShow = (): void => void (leaving = false);
  lifecycle?.addEventListener('pagehide', onPageHide);
  lifecycle?.addEventListener('pageshow', onPageShow);

  const lock: CrossTabLock | null = options.lock !== undefined ? options.lock : storage ? webLock() : null;
  if (storage && options.lock === undefined && !lock) warnNoLocks();
  const router = createRouter(m, handlers, {
    beforeEach: async () => {
      await readThrough();
      m.store.sweepExpired();
      runSchedulers(m.store);
    },
    afterEach: save,
    checkpoint: lock ? async () => undefined : save,
    unloading: () => leaving,
  });
  const serial = <T>(fn: () => Promise<T>): Promise<T> => (lock ? lock(() => router.exclusive(fn)) : router.exclusive(fn));

  const init = async (): Promise<void> => {
    await readThrough();
    await renderGenerated(cfg, m.store);
    await save();
  };
  let ready = serial(init);
  const handle = async (request: Request): Promise<Response> => {
    await ready;
    if (options.delayMs) await delay(options.delayMs);
    return lock ? lock(() => router.handle(request)) : router.handle(request);
  };

  const onStorage = (e: { key: string | null }): void => {
    if (e.key === VERSION_KEY || e.key === null) void serial(readThrough);
  };
  if (storage && g.addEventListener) g.addEventListener('storage', onStorage);

  return {
    handlers: [http.all('*/api/v1/*', ({ request }) => handle(request))],
    get ready() {
      return ready;
    },
    get store() {
      return m.store;
    },
    get persistError() {
      return persistError;
    },
    get openStreams() {
      return hub.openCount;
    },
    handle,
    mailbox,
    reset() {
      ready = serial(async () => {
        hub.closeAll();
        await readThrough();
        const above = m.store.seq.notification;
        await shared?.clear();
        cfg.counters.clear();
        m.store = fresh();
        for (const n of m.store.t.notifications) n.seq += above;
        m.store.seq.notification += above;
        hub.attach(m.store);
        mailbox.length = 0;
        await renderGenerated(cfg, m.store);
        await save();
      });
      return ready;
    },
    totp(email) {
      const secret = m.store.t.users.find((u) => u.email === email.toLowerCase())?.totp_secret;
      if (!secret) throw new Error(`${email} has no TOTP secret`);
      return totpNow(secret, now());
    },
    linkTelegram(code) {
      return serial(async () => {
        await readThrough();
        const entry = m.store.kvTake<{ userId: string }>(`tgcode:${code}`);
        const u = entry ? m.store.get('users', entry.userId) : undefined;
        if (!u) return false;
        m.store.patch(u, { telegram_chat_id: String(100000 + m.store.seq.id) });
        await save();
        return true;
      });
    },
    dispose() {
      hub.closeAll();
      if (storage && g.removeEventListener) g.removeEventListener('storage', onStorage);
      lifecycle?.removeEventListener('pagehide', onPageHide);
      lifecycle?.removeEventListener('pageshow', onPageShow);
    },
  };
}
