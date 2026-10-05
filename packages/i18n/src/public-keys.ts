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
