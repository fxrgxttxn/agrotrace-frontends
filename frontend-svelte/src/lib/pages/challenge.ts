const KEY = 'agrotrace-2fa-challenge';

function entry(): number | null {
  const v = (history.state as Record<string, unknown> | null)?.['sveltekit:history'];
  return typeof v === 'number' ? v : null;
}

export function keepChallenge(id: string): void {
  const at = entry();
  if (at === null) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at, id }));
  } catch {}
}

export function storedChallenge(): string | null {
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { at?: unknown; id?: unknown } | null;
    return kept && kept.at === entry() && typeof kept.id === 'string' ? kept.id : null;
  } catch {
    return null;
  }
}

export function dropChallenge(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}
