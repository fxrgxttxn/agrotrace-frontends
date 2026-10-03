/**
 * @agrotrace/mock-api — a stateful mock of the whole AgroTrace API (contracts/openapi.yaml) that runs in the browser
 * (MSW service worker) and in Node (msw/node): every operation, the contract's check orders and error codes, the
 * business rules of @agrotrace/domain, request schemas of @agrotrace/validation, and the demo world of db/seed.
 *
 *   const api = createMockApi();
 *   await api.ready;
 *   setupWorker(...api.handlers).start({ onUnhandledRequest: 'bypass' });   // or startBrowserMock() (./browser)
 */
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
  /** The clock (default: the real one). The demo world is built relative to it (R73). */
  now?: () => Date | number;
  /** Artificial latency of every response, ms (default 0). */
  delayMs?: number;
  /**
   * Where the state of the origin lives (FM3): `local` (default — localStorage, one backend shared by every tab),
   * `session`, a Storage, or false (in memory only). Without Web Storage (Node) the state is in memory.
   */
  persist?: false | 'session' | 'local' | Storage;
  /** Where persisted upload bytes live (default: IndexedDB when available; null — inside the snapshot). */
  blobStore?: BlobStore | null;
  /**
   * Serializes requests across the tabs of the origin (FM8): read-through, the request and the write run under it, so
   * no tab overwrites another's change. Default: the Web Locks API when the state is persisted; null — per tab only.
   */
  lock?: CrossTabLock | null;
  /** Testing aid: a request that did not mark the store dirty must not have changed the snapshot (throws otherwise). */
  verifyPersistence?: boolean;
  /** Rate-limit counters (default: a small key next to the snapshot when persisted, else in memory). */
  counters?: RateCounters;
  /** `PUBLIC_BASE_URL` for QR codes and e-mail links (default: `location.origin` in a browser, else `http://localhost`). */
  publicBaseUrl?: string;
  /** Reads bundled assets by URL (default: `fetch`). Tests in Node pass a file reader. */
  loadAsset?: AssetLoader;
  /** Users with TOTP enabled from the start: e-mail → base32 secret (default: none, like db/seed). */
  totpUsers?: Record<string, string>;
  /** Enforce contracts/rules/rate-limits.json (default true). */
  rateLimits?: boolean;
  /** Telegram bot username of link codes; null — Telegram unavailable (503). Default `agrotrace_bot`. */
  telegramBot?: string | null;
  /** Every e-mail the mock "sends" (also collected in `api.mailbox`). */
  onMail?: (mail: MockMail) => void;
  /**
   * Where `pagehide`/`pageshow` of the document are heard (default: `globalThis` in a browser; null — never). A request
   * that fails while the document is being unloaded (its own fetches, e.g. a seed asset, are aborted with it) answers
   * 500 without logging: nobody reads that answer.
   */
  lifecycle?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

export interface MockApi {
  /** MSW request handlers (one catch-all for `/api/v1/*` of any origin). */
  handlers: HttpHandler[];
  /** Resolves once the demo world (and its generated documents) is ready; requests wait for it anyway. */
  ready: Promise<void>;
  /** The current state (replaced by `reset` and when another tab changed it). */
  readonly store: Store;
  /** Handles one request without MSW (the same pipeline). */
  handle(request: Request): Promise<Response>;
  /** Rebuilds the demo world and clears the persisted state (snapshot and blobs) — every tab picks it up. */
  reset(): Promise<void>;
  /** Letters "sent" so far by this tab (password reset, invitations) — the demo inbox. */
  mailbox: MockMail[];
  /** Current TOTP code of a user with TOTP enabled. */
  totp(email: string): string;
  /** Emulates the user sending `/start <code>` to the Telegram bot: links the account of the code. */
  linkTelegram(code: string): Promise<boolean>;
  /** SSE streams (`streamEvents`) open in this tab. */
  readonly openStreams: number;
  /** The last persistence failure (e.g. the storage quota), null — none. */
  readonly persistError: unknown;
  /** Stops SSE streams, timers and listeners. */
  dispose(): void;
}

const defaultLoadAsset: AssetLoader = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

let warnedNoLocks = false;
/** Once per page: the state is shared by the tabs but the browser cannot serialize them (no Web Locks). */
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
    // FM4: seed parity — nobody has TOTP enabled; demos and e2e enable it through the profile flow.
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

  /** Adopts the state another tab wrote (and pushes its new notifications to this tab's streams). */
  const readThrough = async (): Promise<void> => {
    const next = shared?.loadIfChanged();
    if (!next) return;
    const seenSeq = m.store.seq.notification;
    // Generated documents already rendered by this tab are reused (same file, same hash) instead of rendered again.
    for (const f of next.t.files) {
      const old = f.regen ? m.store.get('files', f.id) : undefined;
      if (old && old.sha256 === f.sha256 && old.content.type === 'bytes' && old.content.data.length > 0) f.content = old.content;
    }
    const reset = next.epoch !== m.store.epoch;
    m.store = next;
    hub.attach(next);
    await renderGenerated(cfg, next);
    // Another tab reset the world: this tab's streams belong to the old one (their ids mean nothing now) — they are
    // closed, the clients reconnect and get the new world's notifications.
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
      // FM3: never silent — the state of this tab is no longer shared (quota, private mode).
      persistError = e;
      console.error('[mock-api] the state could not be persisted; other tabs will not see this change', e);
    }
  };

  // The document is being unloaded (pagehide; a page restored from the back-forward cache shows again — pageshow).
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
  /** Runs `fn` alone: across the tabs of the origin (the lock) and within this tab (the router's queue). */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => (lock ? lock(() => router.exclusive(fn)) : router.exclusive(fn));

  const init = async (): Promise<void> => {
    // A tab started at the same moment may have written the world first: it is adopted, not overwritten.
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

  // Another tab wrote: adopt it right away, so this tab's SSE streams deliver its notifications.
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
        // FM19: notification ids stay monotonic across resets — the new world starts above the last id any tab saw,
        // so a client reconnecting with an old Last-Event-ID gets the new world's notifications.
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
