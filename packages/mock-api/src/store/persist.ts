/**
 * Optional persistence of the mock's state in Web Storage (sessionStorage / localStorage): tables, keys, sequences
 * and the cookie jar as JSON; uploaded bytes as base64; generated documents are rendered again on load.
 */
import { fromBase64, toBase64 } from '../lib/crypto.js';
import { Store } from './store.js';
import type { FileRow, KvEntry, Sequences, Tables } from './types.js';

export const SNAPSHOT_KEY = 'agrotrace-mock-api';
const FORMAT = 1;

interface Snapshot {
  format: number;
  t: Tables;
  kv: [string, KvEntry][];
  seq: Sequences;
  cookies: [string, string][];
}

type WireContent = { type: 'asset'; url?: string; variants?: Record<string, string> } | { type: 'bytes'; data: string; variants?: Record<string, string> };

export function serialize(store: Store): string {
  const files = store.t.files.map((f) => {
    const c = f.content;
    const content: WireContent =
      c.type === 'asset'
        ? c
        : {
            type: 'bytes',
            data: f.regen ? '' : toBase64(c.data),
            ...(c.variants && { variants: Object.fromEntries(Object.entries(c.variants).map(([k, v]) => [k, toBase64(v)])) }),
          };
    return { ...f, content };
  });
  const snapshot = {
    format: FORMAT,
    t: { ...store.t, files },
    kv: [...store.kv],
    seq: store.seq,
    cookies: [...store.cookies],
  };
  return JSON.stringify(snapshot);
}

export function deserialize(json: string, clock: () => number): Store | null {
  let s: Snapshot;
  try {
    s = JSON.parse(json) as Snapshot;
  } catch {
    return null;
  }
  if (s.format !== FORMAT) return null;
  const store = new Store(clock);
  const files = (s.t.files as unknown as (Omit<FileRow, 'content'> & { content: WireContent })[]).map((f) => {
    const c = f.content;
    const content: FileRow['content'] =
      c.type === 'asset'
        ? c
        : {
            type: 'bytes',
            data: fromBase64(c.data),
            ...(c.variants && { variants: Object.fromEntries(Object.entries(c.variants).map(([k, v]) => [k, fromBase64(v)])) }),
          };
    return { ...f, content } as FileRow;
  });
  store.t = { ...s.t, files };
  store.kv = new Map(s.kv);
  store.seq = s.seq;
  store.cookies = new Map(s.cookies);
  store.reindex();
  return store;
}
