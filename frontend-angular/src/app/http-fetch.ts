import { HttpClient, HttpErrorResponse, HttpHeaders, type HttpResponse } from '@angular/common/http';

const NULL_BODY = new Set([101, 204, 205, 304]);

function toResponse(
  status: number,
  statusText: string,
  headers: HttpHeaders,
  body: ArrayBuffer | null,
): Response {
  const h = new Headers();
  for (const name of headers.keys()) for (const value of headers.getAll(name) ?? []) h.append(name, value);
  return new Response(NULL_BODY.has(status) ? null : (body ?? null), { status, statusText, headers: h });
}

export function httpClientFetch(http: HttpClient): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && init === undefined ? input : new Request(input, init);
    let headers = new HttpHeaders();
    req.headers.forEach((value, name) => {
      headers = headers.append(name, value);
    });
    const raw = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
    const body = raw && raw.byteLength > 0 ? raw : null;
    if (req.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        sub.unsubscribe();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const done = () => req.signal.removeEventListener('abort', onAbort);
      const sub = http
        .request(req.method, req.url, {
          body,
          headers,
          observe: 'response',
          responseType: 'arraybuffer',
          withCredentials: req.credentials === 'include',
        })
        .subscribe({
          next: (res: HttpResponse<ArrayBuffer>) => {
            done();
            resolve(toResponse(res.status, res.statusText, res.headers, res.body));
          },
          error: (e: unknown) => {
            done();
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
      req.signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}
