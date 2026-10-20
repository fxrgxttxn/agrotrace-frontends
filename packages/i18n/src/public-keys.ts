// Ruling FM35: the keys the public QR page (/p/:publicCode, /p/:publicCode/complaint) and its error / boot screens
// use — a key names a leaf or a whole namespace. `public/<locale>.json` is the projection of each full dictionary on
// these keys (scripts/build-public.ts writes it; test/public.test.ts fails when it is stale). A frontend adding a text
// to its public page adds the key here and rebuilds the subset.

export const PUBLIC_KEYS = [
  'page.publicBatch',
  'page.publicComplaint',
  'empty.pageLoadFailed',
  'action.retry',
  'auth.retryIn',
  'auth.rateLimited',
  'shell.loading',
  'status.safety',
  'orgType',
  'labConclusion',
  'errors.VALIDATION',
  'errors.NOT_FOUND',
  'errors.RATE_LIMITED',
  'errors.CAPTCHA_FAILED',
  'errors.BACKEND_UNAVAILABLE',
  'errors.INTERNAL',
  'errors.UNKNOWN',
  'validation.required',
  'validation.minLength',
  'validation.maxLength',
  'validation.pattern',
  'public',
] as const;

type Node = Record<string, unknown>;

/** The projection of a full dictionary on {@link PUBLIC_KEYS} (same nesting, nothing else). */
export function pickPublic(dict: object): Node {
  const out: Node = {};
  for (const key of PUBLIC_KEYS) {
    const path = key.split('.');
    let src: unknown = dict;
    for (const k of path) src = (src as Node | undefined)?.[k];
    if (src === undefined) throw new Error(`public key ${key} is missing`);
    let dst = out;
    for (const k of path.slice(0, -1)) dst = (dst[k] ??= {}) as Node;
    dst[path.at(-1)!] = src;
  }
  return out;
}
