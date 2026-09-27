/** Runtime configuration of one mock instance (createMockApi options with defaults applied). */
import type { AssetLoader } from './render/documents.js';

export interface MockConfig {
  /** The mock's clock (epoch ms). */
  now: () => number;
  /** `PUBLIC_BASE_URL`: the origin (+ optional path) of the public batch page `/p/{publicCode}` encoded in QR codes. */
  publicBaseUrl: string;
  /** Reads a bundled asset (seed images, PDF fonts) by the URL its import produced. */
  loadAsset: AssetLoader;
  /** Users (e-mails) who have TOTP enabled in the demo world, with their base32 secret. */
  totpUsers: Record<string, string>;
  /** Enforce `contracts/rules/rate-limits.json`. */
  rateLimits: boolean;
  /** Secret of access-token signatures and signed file URLs. */
  secret: string;
  /** Telegram bot of `createTelegramCode` (null — 503 EXTERNAL_UNAVAILABLE as with an unset token). */
  telegramBot: string | null;
  /** Called with every e-mail the mock "sends" (password reset, invitations) — the demo's inbox. */
  onMail: (mail: MockMail) => void;
  /** Where persisted upload bytes live (IndexedDB in browsers); null — kept in the snapshot. */
  blobs: BlobStore | null;
  /** Rate-limit counters (FM19): outside the world's snapshot — counting a request is not a change of the world. */
  counters: RateCounters;
}

/**
 * Fixed-window rate-limit counters (R30) kept apart from the world (FM19): a request that only reads counts without
 * making the snapshot dirty; other tabs re-read nothing and no SSE counter is pushed.
 */
export interface RateCounters {
  /** INCR of `key` (a window ending at `expiresAt`, epoch ms): the new count. Expired windows are dropped. */
  hit(key: string, expiresAt: number, now: number): number;
  /** The live count of `key` (0: none or expired). */
  peek(key: string, now: number): number;
  /** Every stored key, expired ones included (tests: expired windows must not pile up). */
  keys(): string[];
  clear(): void;
}

type Windows = Record<string, [count: number, expiresAt: number]>;

const live = (w: Windows, now: number): Windows => Object.fromEntries(Object.entries(w).filter(([, [, exp]]) => exp > now));

/** Counters of one tab (Node, `persist: false`). */
export function memoryCounters(): RateCounters {
  let w: Windows = {};
  return {
    hit(key, expiresAt, now) {
      w = live(w, now);
      const count = (w[key]?.[0] ?? 0) + 1;
      w[key] = [count, expiresAt];
      return count;
    },
    peek: (key, now) => live(w, now)[key]?.[0] ?? 0,
    keys: () => Object.keys(w),
    clear: () => void (w = {}),
  };
}

export const COUNTERS_KEY = 'agrotrace-mock-api:rate-limits';

/**
 * Counters shared by the tabs of the origin: one small JSON key next to the snapshot (a few windows; expired ones are
 * dropped on every hit). Requests run under the cross-tab lock, so read-increment-write is not interleaved. When the
 * storage refuses the write (quota) this tab keeps counting in memory.
 */
export function storageCounters(storage: Storage): RateCounters {
  /** The windows as this tab last knew them: what counting continues from while the storage refuses writes. */
  let known: Windows = {};
  let failing = false;
  const read = (): Windows => {
    if (failing) return known;
    try {
      return JSON.parse(storage.getItem(COUNTERS_KEY) ?? '{}') as Windows;
    } catch {
      return known;
    }
  };
  return {
    hit(key, expiresAt, now) {
      const w = live(read(), now);
      const count = (w[key]?.[0] ?? 0) + 1;
      w[key] = [count, expiresAt];
      known = w;
      try {
        storage.setItem(COUNTERS_KEY, JSON.stringify(w));
        failing = false;
      } catch {
        // Quota: this tab keeps counting from the last known count (the limit is never reset by a failed write).
        failing = true;
      }
      return count;
    },
    peek: (key, now) => live(read(), now)[key]?.[0] ?? 0,
    keys: () => Object.keys(read()),
    clear() {
      storage.removeItem(COUNTERS_KEY);
      known = {};
      failing = false;
    },
  };
}

export interface BlobStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

export interface MockMail {
  kind: 'passwordReset' | 'invite';
  to: string;
  link: string;
  token: string;
  at: string;
}

/**
 * Runs `fn` while no other tab of the origin runs one (FM8): the Web Locks API in browsers
 * (`navigator.locks.request('agrotrace-mock-api', {mode: 'exclusive'}, fn)`); tests inject their own.
 */
export type CrossTabLock = <T>(fn: () => Promise<T>) => Promise<T>;

/** The Web Locks lock of the origin; null where the API is absent (each tab then only queues its own requests). */
export function webLock(name = 'agrotrace-mock-api'): CrossTabLock | null {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks) return null;
  return <T>(fn: () => Promise<T>) => locks.request(name, { mode: 'exclusive' }, fn) as Promise<T>;
}
