// The QR page's batch request, started by the entry (src/hooks.client.ts) while the public route chunks are still
// downloading, so the answer does not wait for it (LCP on a phone). Only the transport starts early: the public data
// layer takes the Response once through createPublicApi's `fetch` option, and api-client reads it as any other.
// No dependencies (the entry stays light).

interface Early {
  url: string;
  response: Promise<Response | Error>;
}

let early: Early | null = null;

/** The batch URL of a QR page path (`/p/:code`, `/p/:code/complaint`), or null. */
export function earlyBatchUrl(path: string, origin: string): string | null {
  const code = /^\/p\/(AT-\d{4}-\d{6,})(\/complaint)?\/?$/.exec(path)?.[1];
  return code ? `${origin}/api/v1/public/batches/${code}` : null;
}

export function startEarly(url: string): void {
  early = { url, response: fetch(url).catch((e: Error) => e) };
}

/** The early response of `url`, once; null when there is none for it. */
export function takeEarly(url: string): Promise<Response> | null {
  if (!early || early.url !== url) return null;
  const { response } = early;
  early = null;
  return response.then((r) => (r instanceof Response ? r : Promise.reject(r)));
}
