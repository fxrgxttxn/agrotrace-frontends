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
