/**
 * DateTime comparisons (P38). The contract's `DateTime` is "ISO 8601 in UTC with Z" with no fixed precision: Express
 * prints milliseconds, PostgreSQL keeps microseconds and Laravel/DRF print them. tests/api therefore compares
 * DateTime values as instants — never as exact strings — whether they come from a response, an outbox payload, an
 * audit diff, the DB or the test's own arithmetic. `Date.parse` keeps milliseconds (sub-millisecond digits are
 * dropped), so equal instants at any printed precision compare equal.
 */

/** A contract DateTime (`…T…Z`, any number of fractional digits). */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Milliseconds since the epoch of a DateTime string (or a Date). */
export function instant(v: string | Date): number {
  return typeof v === 'string' ? Date.parse(v) : v.getTime();
}

/**
 * A deep copy of `v` where every DateTime string is replaced by `{instant: <ms>}`, for `toEqual`/`toMatchObject` of
 * objects that carry DateTimes: `expect(instants(actual)).toEqual(instants(expected))`. Asymmetric matchers
 * (`expect.any(String)`) are left untouched.
 */
export function instants<T>(v: T): T {
  if (typeof v === 'string') return (DATE_TIME.test(v) ? { instant: Date.parse(v) } : v) as T;
  if (v instanceof Date) return { instant: v.getTime() } as T;
  if (Array.isArray(v)) return v.map((x) => instants(x)) as T;
  if (v !== null && typeof v === 'object') {
    if (typeof (v as { asymmetricMatch?: unknown }).asymmetricMatch === 'function') return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, instants(x)])) as T;
  }
  return v;
}

/** A signed file URL (R39): `/api/v1/files/{id}?exp=<unix>&sig=<hex>`. */
const SIGNED = /^(\/api\/v1\/files\/[0-9a-f-]{36})\?exp=\d+&sig=[0-9a-f]+$/;

/**
 * `instants(v)` that also drops the expiry and signature of signed file URLs (avatars in ActorRef, protocol links):
 * two responses of the same entity built a second apart carry different `exp`/`sig` by design (TTL from the request
 * time), so comparisons across requests keep only the file path.
 */
export function comparable<T>(v: T): T {
  const strip = (x: unknown): unknown => {
    if (typeof x === 'string') return SIGNED.test(x) ? x.replace(SIGNED, '$1?signed') : x;
    if (Array.isArray(x)) return x.map(strip);
    if (
      x !== null &&
      typeof x === 'object' &&
      typeof (x as { asymmetricMatch?: unknown }).asymmetricMatch !== 'function'
    )
      return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, strip(y)]));
    return x;
  };
  return instants(strip(v) as T);
}
