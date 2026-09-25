/**
 * @agrotrace/mock-api — a stateful mock of the whole AgroTrace API (contracts/openapi.yaml) that runs in the browser
 * (MSW service worker) and in Node (msw/node): every operation, the contract's check orders and error codes, the
 * business rules of @agrotrace/domain, request schemas of @agrotrace/validation, and the demo world of db/seed.
 *
 *   const api = createMockApi({ persist: 'session' });
 *   await api.ready;
 *   setupWorker(...api.handlers).start({ onUnhandledRequest: 'bypass' });   // or startBrowserMock() (./browser)
 */
import { delay, http, type HttpHandler } from 'msw';
import type { MockConfig, MockMail } from './config.js';
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
import { deserialize, serialize, SNAPSHOT_KEY } from './store/persist.js';
import { buildSeed } from './store/seed.js';
import type { Store } from './store/store.js';

export { DEMO_PASSWORD } from './store/seed.js';
export type { MockMail } from './config.js';
export { solveChallenge } from './domain/altcha.js';
export { totpNow } from './domain/tokens.js';

/** The TOTP secret of `inspector.head@agrotrace.test` in the demo world (base32; codes: `api.totp(email)`). */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export interface MockApiOptions {
  /** The clock (default: the real one). The demo world is built relative to it (R73). */
  now?: () => Date | number;
  /** Artificial latency of every response, ms (default 0). */
  delayMs?: number;
  /** Keep the state across page reloads: `session` (sessionStorage), `local` (localStorage) or a Storage; default off. */
  persist?: false | 'session' | 'local' | Storage;
  /** `PUBLIC_BASE_URL` for QR codes and e-mail links (default: `location.origin` in a browser, else `http://localhost`). */
  publicBaseUrl?: string;
  /** Reads bundled assets by URL (default: `fetch`). Tests in Node pass a file reader. */
  loadAsset?: AssetLoader;
  /** Users with TOTP enabled: e-mail → base32 secret (default: inspector.head with DEMO_TOTP_SECRET). */
  totpUsers?: Record<string, string>;
  /** Enforce contracts/rules/rate-limits.json (default true). */
  rateLimits?: boolean;
  /** Telegram bot username of link codes; null — Telegram unavailable (503). Default `agrotrace_bot`. */
  telegramBot?: string | null;
  /** Every e-mail the mock "sends" (also collected in `api.mailbox`). */
  onMail?: (mail: MockMail) => void;
}

export interface MockApi {
  /** MSW request handlers (one catch-all for `/api/v1/*` of any origin). */
  handlers: HttpHandler[];
  /** Resolves once the demo world (and its generated documents) is ready; requests wait for it anyway. */
  ready: Promise<void>;
  /** The current state (replaced by `reset`). */
  readonly store: Store;
  /** Handles one request without MSW (the same pipeline). */
  handle(request: Request): Promise<Response>;
  /** Rebuilds the demo world (and clears the persisted snapshot). */
  reset(): Promise<void>;
  /** Letters "sent" so far (password reset, invitations) — the demo inbox. */
  mailbox: MockMail[];
  /** Current TOTP code of a user with TOTP enabled. */
  totp(email: string): string;
  /** Emulates the user sending `/start <code>` to the Telegram bot: links the account of the code. */
  linkTelegram(code: string): boolean;
  /** Stops SSE streams and timers. */
  dispose(): void;
}

const defaultLoadAsset: AssetLoader = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

function storageOf(persist: MockApiOptions['persist']): Storage | null {
  if (!persist) return null;
  if (typeof persist === 'object') return persist;
  const g = globalThis as { sessionStorage?: Storage; localStorage?: Storage };
  return (persist === 'session' ? g.sessionStorage : g.localStorage) ?? null;
}

export function createMockApi(options: MockApiOptions = {}): MockApi {
  const clock = options.now ?? (() => Date.now());
  const now = (): number => {
    const v = clock();
    return typeof v === 'number' ? v : v.getTime();
  };
  const mailbox: MockMail[] = [];
  const g = globalThis as { location?: { origin: string } };
  const totpUsers = options.totpUsers ?? { 'inspector.head@agrotrace.test': DEMO_TOTP_SECRET };
  const cfg: MockConfig = {
    now,
    publicBaseUrl: options.publicBaseUrl ?? g.location?.origin ?? 'http://localhost',
    loadAsset: options.loadAsset ?? defaultLoadAsset,
    totpUsers,
    rateLimits: options.rateLimits ?? true,
    secret: 'agrotrace-mock-api-secret',
    telegramBot: options.telegramBot === undefined ? 'agrotrace_bot' : options.telegramBot,
    onMail: (mail) => {
      mailbox.push(mail);
      options.onMail?.(mail);
    },
  };
  const storage = storageOf(options.persist);

  const fresh = (): Store => buildSeed(cfg).store;
  const restored = storage ? deserialize(storage.getItem(SNAPSHOT_KEY) ?? '', now) : null;
  const m: Mock = { cfg, store: restored ?? fresh() };
  let hub = new EventHub(m.store);

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
  };
  let notifications = notificationsHandlers(hub);
  const dispatch = (name: string): Handler => (ctx) => notifications[name]!(ctx);
  for (const name of Object.keys(notifications)) handlers[name] = dispatch(name);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    if (!storage || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        storage.setItem(SNAPSHOT_KEY, serialize(m.store));
      } catch (e) {
        console.warn('[mock-api] could not persist the state', e);
      }
    }, 0);
  };

  let ready = renderGenerated(cfg, m.store);
  const route = createRouter(m, handlers, { beforeEach: () => runSchedulers(m.store), afterWrite: save });
  const handle = async (request: Request): Promise<Response> => {
    await ready;
    if (options.delayMs) await delay(options.delayMs);
    return route(request);
  };

  const api: MockApi = {
    handlers: [http.all('*/api/v1/*', ({ request }) => handle(request))],
    get ready() {
      return ready;
    },
    get store() {
      return m.store;
    },
    handle,
    mailbox,
    async reset() {
      hub.closeAll();
      m.store = fresh();
      hub = new EventHub(m.store);
      notifications = notificationsHandlers(hub);
      mailbox.length = 0;
      storage?.removeItem(SNAPSHOT_KEY);
      ready = renderGenerated(cfg, m.store);
      await ready;
    },
    totp(email) {
      const secret = m.store.t.users.find((u) => u.email === email.toLowerCase())?.totp_secret;
      if (!secret) throw new Error(`${email} has no TOTP secret`);
      return totpNow(secret, now());
    },
    linkTelegram(code) {
      const entry = m.store.kvTake<{ userId: string }>(`tgcode:${code}`);
      const u = entry ? m.store.get('users', entry.userId) : undefined;
      if (!u) return false;
      m.store.patch(u, { telegram_chat_id: String(100000 + m.store.seq.id) });
      save();
      return true;
    },
    dispose() {
      hub.closeAll();
      if (saveTimer) clearTimeout(saveTimer);
    },
  };
  return api;
}
