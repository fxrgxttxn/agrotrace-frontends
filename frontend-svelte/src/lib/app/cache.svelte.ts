// Server data cache (spec §9.2 for Svelte: `.svelte.ts` modules with `$state` and their own request cache). Keys are
// arrays (`['notifications', 'page', 1]`); `invalidate(prefix)` marks every entry under a prefix stale and tells its
// readers to refetch; `clear()` forgets everything (logout). Screens of later tasks read through `cache.get`.

type Key = readonly (string | number | boolean | null)[];

interface Entry {
  value: unknown;
  stale: boolean;
}

const keyOf = (key: Key) => JSON.stringify(key);

class Cache {
  #entries = new Map<string, Entry>();
  /** Bumped by `invalidate`/`clear`: readers that depend on it refetch. */
  version = $state(0);

  get<T>(key: Key): T | undefined {
    const e = this.#entries.get(keyOf(key));
    return e && !e.stale ? (e.value as T) : undefined;
  }

  set(key: Key, value: unknown): void {
    this.#entries.set(keyOf(key), { value, stale: false });
  }

  /** Marks every entry whose key starts with `prefix` stale. */
  invalidate(prefix: Key): void {
    const head = keyOf(prefix).slice(0, -1);
    for (const [k, e] of this.#entries) if (k === `${head}]` || k.startsWith(`${head},`)) e.stale = true;
    this.version += 1;
  }

  clear(): void {
    this.#entries.clear();
    this.version += 1;
  }
}

export const cache = new Cache();
