// The 2FA challenge of a login lives in the history state of `/login/2fa` (as React's location.state). SvelteKit
// restores `page.state` on back/forward but starts every document with an empty one, so for a reload of that entry the
// challenge is also kept in this tab's sessionStorage — written with the history entry, dropped when the step ends
// (signed in, challenge gone) or a new login starts.

const KEY = 'agrotrace-2fa-challenge';

export function keepChallenge(id: string): void {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // storage unavailable: the step lasts as long as the history entry's state
  }
}

export function storedChallenge(): string | null {
  try {
    return sessionStorage.getItem(KEY);
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
