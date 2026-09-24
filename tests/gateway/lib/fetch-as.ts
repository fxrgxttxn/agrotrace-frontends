// fetch() silently drops a caller-set `Host` header (it's on the WHATWG forbidden-header list),
// which makes it useless for virtual-host testing: every request would land on default_server
// regardless of the Host we asked for. node:http has no such restriction, so it's used directly
// to actually reach {front}-{back}.localhost / localhost / foo.localhost on the gateway service.
import http from 'node:http';

export interface SimpleResponse {
  status: number;
  headers: { get(name: string): string | null; getAll(name: string): string[] };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface FetchAsOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

export function fetchAs(host: string, path: string, opts: FetchAsOptions = {}): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request(
      {
        host: 'gateway',
        port: 80,
        path,
        method: opts.method ?? 'GET',
        headers: {
          Host: host,
          ...(opts.body ? { 'Content-Length': String(opts.body.length) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          settled = true;
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              get: (name: string) => {
                const v = res.headers[name.toLowerCase()];
                return Array.isArray(v) ? v.join(', ') : (v ?? null);
              },
              // rawHeaders keeps every repeated header as a separate entry — needed to actually
              // detect duplicates, which res.headers (a plain object) collapses.
              getAll: (name: string) => {
                const out: string[] = [];
                for (let i = 0; i < res.rawHeaders.length; i += 2) {
                  if (res.rawHeaders[i].toLowerCase() === name.toLowerCase()) out.push(res.rawHeaders[i + 1]);
                }
                return out;
              },
            },
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
          });
        });
      },
    );
    // A large-body request can have nginx answer 413 and close the connection before the write
    // finishes; once we already have a full response, a late write-side ECONNRESET is expected
    // and harmless, not a test failure.
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Same as fetchAs, but returns the raw chunks (with their arrival timestamps) instead of waiting
// for the response to finish — needed to prove SSE events arrive as separate, unbuffered writes
// rather than all at once when the connection closes.
export function streamAs(
  host: string,
  path: string,
  opts: FetchAsOptions = {},
): Promise<{ status: number; chunks: { at: number; text: string }[] }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const chunks: { at: number; text: string }[] = [];
    const req = http.request(
      {
        host: 'gateway',
        port: 80,
        path,
        method: opts.method ?? 'GET',
        headers: { Host: host, ...opts.headers },
      },
      (res) => {
        res.on('data', (c: Buffer) => chunks.push({ at: Date.now() - start, text: c.toString('utf8') }));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, chunks }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
