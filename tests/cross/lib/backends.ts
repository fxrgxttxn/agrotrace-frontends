/**
 * The pair of backends a cross scenario runs against: CROSS_API_URLS = "<url A>,<url B>" (`./at cross:test <a> <b>`
 * sets http://api-<a>:8000/api/v1,http://api-<b>:8000/api/v1). Until Plan 3 brings api-django and api-laravel, the
 * default pair is Express with itself — a stub that keeps the scaffold running; the scenarios do not change when the
 * real pairs arrive.
 */
export type Backend = 'express' | 'django' | 'laravel';

export interface Target {
  url: string;
  /** Expected `X-Backend` of every response. */
  backend: Backend;
}

const raw = process.env.CROSS_API_URLS ?? 'http://api-express:8000/api/v1,http://api-express:8000/api/v1';

function target(url: string): Target {
  const m = /\/\/api-(express|django|laravel)[:/]/.exec(url);
  if (!m)
    throw new Error(`CROSS_API_URLS: cannot tell the backend of ${url} (expected http://api-<backend>:…)`);
  return { url: url.replace(/\/$/, ''), backend: m[1] as Backend };
}

const urls = raw.split(',').map((s) => s.trim());
if (urls.length !== 2)
  throw new Error(`CROSS_API_URLS must hold exactly two URLs, got ${JSON.stringify(raw)}`);

export const [A, B] = urls.map(target) as [Target, Target];
/** True while both sides are the same backend (the pre-Plan-3 stub). */
export const STUB = A.backend === B.backend;
