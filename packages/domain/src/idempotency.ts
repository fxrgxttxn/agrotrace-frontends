/**
 * Idempotency-Key handling (BR-11). The key pattern excludes `\n`, and in
 * JavaScript `$` (without the `m` flag) anchors strictly to the end of the
 * input rather than allowing a trailing line terminator before it (unlike
 * some other regex flavors) - so this is already a full-string match; a
 * key with a trailing "\n" correctly fails to match (R2/R21 lock this in
 * via a vector case).
 */
export function idempotencyDecision(i: {
  key: string;
  stored: { fingerprint: string } | null;
  fingerprint: string;
}): { decision: 'INVALID_KEY' | 'EXECUTE' | 'REPLAY' | 'CONFLICT' } {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(i.key)) return { decision: 'INVALID_KEY' };
  if (!i.stored) return { decision: 'EXECUTE' };
  return { decision: i.stored.fingerprint === i.fingerprint ? 'REPLAY' : 'CONFLICT' };
}
