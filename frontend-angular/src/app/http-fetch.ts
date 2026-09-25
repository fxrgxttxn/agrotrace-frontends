import { HttpClient, HttpErrorResponse, HttpHeaders, type HttpResponse } from '@angular/common/http';

// `HttpClient` adapter of api-client (spec §9.2 «HttpClient-адаптер к api-client»): api-client keeps the protocol
// (Bearer, single-flight refresh under a Web Lock, Idempotency-Key retries, R32/R61/R62) and hands every attempt to this
// `fetch` — the request itself goes through Angular's HttpClient (interceptors, testing backend). HTTP error statuses
// come back as ordinary `Response`s, exactly as from `fetch`; a transport failure (status 0) rejects with a `TypeError`,
// as `fetch` does, so api-client treats it as a transient failure (R61).

const NULL_BODY = new Set([101, 204, 205, 304]);

function toResponse(
  status: number,
  statusText: string,
  headers: HttpHeaders,
  body: ArrayBuffer | null,
): Response {
  const h = new Headers();
  for (const name of headers.keys()) {
    const value = headers.get(name);
    if (value !== null) h.set(name, value);
  }
  return new Response(NULL_BODY.has(status) ? null : (body ?? null), { status, statusText, headers: h });
}

export function httpClientFetch(http: HttpClient): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && init === undefined ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const raw = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
    const body = raw && raw.byteLength > 0 ? raw : null;
    if (req.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Promise<Response>((resolve, reject) => {
      const sub = http
        .request(req.method, req.url, {
          body,
          headers: new HttpHeaders(headers),
          observe: 'response',
          responseType: 'arraybuffer',
          withCredentials: req.credentials === 'include',
        })
        .subscribe({
          next: (res: HttpResponse<ArrayBuffer>) =>
            resolve(toResponse(res.status, res.statusText, res.headers, res.body)),
          error: (e: unknown) => {
            if (e instanceof HttpErrorResponse && e.status > 0)
              resolve(
                toResponse(
                  e.status,
                  e.statusText,
                  e.headers,
                  e.error instanceof ArrayBuffer ? e.error : null,
                ),
              );
            else reject(new TypeError('Failed to fetch'));
          },
        });
      req.signal.addEventListener('abort', () => {
        sub.unsubscribe();
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  };
}
