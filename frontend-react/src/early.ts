interface Early {
  url: string;
  response: Promise<Response | Error>;
}

let early: Early | null = null;

export function earlyBatchUrl(path: string, origin: string): string | null {
  const code = /^\/p\/(AT-\d{4}-\d{6,})(\/complaint)?\/?$/.exec(path)?.[1];
  return code ? `${origin}/api/v1/public/batches/${code}` : null;
}

export function startEarly(url: string): void {
  early = { url, response: fetch(url).catch((e: Error) => e) };
}

export function takeEarly(url: string): Promise<Response> | null {
  if (!early || early.url !== url) return null;
  const { response } = early;
  early = null;
  return response.then((r) => (r instanceof Response ? r : Promise.reject(r)));
}
