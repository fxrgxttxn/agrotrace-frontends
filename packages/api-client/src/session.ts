/** Holds the current access token and notifies listeners when it changes. Framework-agnostic: a
 * React/Angular/Svelte store adapter wraps its own reactive primitive around the same interface. */
export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
  subscribe(fn: (token: string | null) => void): () => void;
}

/** Plain in-memory TokenStore — the default for tests and for apps that keep the access token
 * only in JS memory (never localStorage, per the spec's XSS posture). */
export function createMemoryTokenStore(initial: string | null = null): TokenStore {
  let token = initial;
  const listeners = new Set<(token: string | null) => void>();

  return {
    get(): string | null {
      return token;
    },
    set(next: string | null): void {
      token = next;
      for (const fn of listeners) fn(token);
    },
    subscribe(fn: (token: string | null) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
