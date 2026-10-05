export function idempotencyDecision(i: {
  key: string;
  stored: { fingerprint: string } | null;
  fingerprint: string;
}): { decision: 'INVALID_KEY' | 'EXECUTE' | 'REPLAY' | 'CONFLICT' } {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(i.key)) return { decision: 'INVALID_KEY' };
  if (!i.stored) return { decision: 'EXECUTE' };
  return { decision: i.stored.fingerprint === i.fingerprint ? 'REPLAY' : 'CONFLICT' };
}
