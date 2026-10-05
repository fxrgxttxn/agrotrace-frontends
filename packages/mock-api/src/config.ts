import type { AssetLoader } from './render/documents.js';

export interface MockConfig {
  now: () => number;
  publicBaseUrl: string;
  loadAsset: AssetLoader;
  totpUsers: Record<string, string>;
  rateLimits: boolean;
  secret: string;
  telegramBot: string | null;
  onMail: (mail: MockMail) => void;
  blobs: BlobStore | null;
  counters: RateCounters;
}

export interface RateCounters {
  hit(key: string, expiresAt: number, now: number): number;
  peek(key: string, now: number): number;
  keys(): string[];
  clear(): void;
}

type Windows = Record<string, [count: number, expiresAt: number]>;

const live = (w: Windows, now: number): Windows => Object.fromEntries(Object.entries(w).filter(([, [, exp]]) => exp > now));

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

export function storageCounters(storage: Storage): RateCounters {
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

export type CrossTabLock = <T>(fn: () => Promise<T>) => Promise<T>;

export function webLock(name = 'agrotrace-mock-api'): CrossTabLock | null {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks) return null;
  return <T>(fn: () => Promise<T>) => locks.request(name, { mode: 'exclusive' }, fn) as Promise<T>;
}
