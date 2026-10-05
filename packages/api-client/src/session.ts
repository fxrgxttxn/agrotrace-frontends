export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
  subscribe(fn: (token: string | null) => void): () => void;
}

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
