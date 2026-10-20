// The QR page's batch request, started by the shared entry (main.ts) while the public page — its own build, Angular
// and the page — is still downloading, so the answer does not wait for it (LCP on a phone). Only the transport starts
// early: the public data layer takes the Response once through createPublicApi's `fetch` option. The two builds share
// no module state, so the request waits in a global slot. No dependencies (the entry stays light).

interface Early {
  url: string;
  response: Promise<Response | Error>;
}

const SLOT = '__agrotraceEarly';
const slot = globalThis as unknown as Record<typeof SLOT, Early | null | undefined>;

/** The batch URL of a QR page path (`/p/:code`, `/p/:code/complaint`), or null. */
export function earlyBatchUrl(path: string, origin: string): string | null {
  const code = /^\/p\/(AT-\d{4}-\d{6,})(\/complaint)?\/?$/.exec(path)?.[1];
  return code ? `${origin}/api/v1/public/batches/${code}` : null;
}

export function startEarly(url: string): void {
  slot[SLOT] = { url, response: fetch(url).catch((e: Error) => e) };
}

/** The early response of `url`, once; null when there is none for it. */
export function takeEarly(url: string): Promise<Response> | null {
  const early = slot[SLOT];
  if (!early || early.url !== url) return null;
  slot[SLOT] = null;
  return early.response.then((r) => (r instanceof Response ? r : Promise.reject(r)));
}
