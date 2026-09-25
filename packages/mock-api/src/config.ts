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
}

export interface MockMail {
  kind: 'passwordReset' | 'invite';
  to: string;
  link: string;
  token: string;
  at: string;
}
