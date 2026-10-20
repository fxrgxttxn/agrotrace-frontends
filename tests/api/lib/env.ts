/**
 * Where the backend under test is. The suite is backend-agnostic: `./at.sh api:test <backend>` sets API_URL to
 * http://api-<backend>:8000/api/v1 and API_BACKEND to the expected `X-Backend` value.
 */
export type Backend = 'express' | 'django' | 'laravel';

export const API_URL = (process.env.API_URL ?? 'http://api-express:8000/api/v1').replace(/\/$/, '');

/** Expected `X-Backend` on every response: API_BACKEND, else the `api-<name>` host of API_URL, else express. */
export const API_BACKEND: Backend = (process.env.API_BACKEND ??
  /\/\/api-(express|django|laravel)[:/]/.exec(API_URL)?.[1] ??
  'express') as Backend;
