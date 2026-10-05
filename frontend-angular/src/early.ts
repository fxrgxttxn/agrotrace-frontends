interface Early {
  url: string;
  response: Promise<Response | Error>;
}

const SLOT = '__agrotraceEarly';
const slot = globalThis as unknown as Record<typeof SLOT, Early | null | undefined>;

export function earlyBatchUrl(path: string, origin: string): string | null {
  const code = /^\/p\/(AT-\d{4}-\d{6,})(\/complaint)?\/?$/.exec(path)?.[1];
  return code ? `${origin}/api/v1/public/batches/${code}` : null;
}

export function startEarly(url: string): void {
  slot[SLOT] = { url, response: fetch(url).catch((e: Error) => e) };
}

export function takeEarly(url: string): Promise<Response> | null {
  const early = slot[SLOT];
  if (!early || early.url !== url) return null;
  slot[SLOT] = null;
  return early.response.then((r) => (r instanceof Response ? r : Promise.reject(r)));
}
