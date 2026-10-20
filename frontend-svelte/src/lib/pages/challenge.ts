// The 2FA challenge of a login lives in the history state of the `/login/2fa` entry (as React's location.state).
// SvelteKit restores `page.state` on back/forward but starts every document with an empty one, so for a reload of that
// entry the challenge is also kept in this tab's sessionStorage together with the entry's own key (SvelteKit's
// `sveltekit:history` index, which a reload keeps). Ruling FM27: only a reload of the same entry finds it — a typed
// `/login/2fa` is a new entry and goes to /login. It is dropped when the step ends (signed in, challenge gone) and when
// the login screen shows.

const KEY = 'agrotrace-2fa-challenge';

/** The key of the current history entry, or null outside SvelteKit's history. `sveltekit:history` is an internal of
 * SvelteKit's client router (kept on every entry and across a reload): @sveltejs/kit is pinned (2.70.3, package.json)
 * and the e2e `auth.spec.ts` (challenge survives a reload, a typed entry goes to /login) checks it on every upgrade.
 * Without it the page still works — only a reload of the 2FA step goes back to /login. */
function entry(): number | null {
  const v = (history.state as Record<string, unknown> | null)?.['sveltekit:history'];
  return typeof v === 'number' ? v : null;
}

/** Remembers the challenge of the current entry (call once the `/login/2fa` entry is committed). */
export function keepChallenge(id: string): void {
  const at = entry();
  if (at === null) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at, id }));
  } catch {
    // storage unavailable: the step lasts as long as the history entry's state
  }
}

/** The challenge kept for the current entry (a reload of it), or null. */
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
  } catch {
    // storage unavailable
  }
}
