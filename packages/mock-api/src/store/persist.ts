import type { BlobStore } from '../config.js';
import { fromBase64, hex, randomBytes, toBase64 } from '../lib/crypto.js';
import { Store } from './store.js';
import type { FileRow, KvEntry, Sequences, Tables } from './types.js';

export const SNAPSHOT_KEY = 'agrotrace-mock-api';
const FORMAT = 2;

interface Snapshot {
  format: number;
  t: Tables;
  kv: [string, KvEntry][];
  epoch?: string;
  seq: Sequences;
  cookies: [string, string][];
}

type WireContent =
  | { type: 'asset'; url?: string; variants?: Record<string, string> }
  | { type: 'bytes'; data: string; variants?: Record<string, string> }
  | { type: 'blob' };

export async function storeBlobs(store: Store, blobs: BlobStore, saved: Set<string>): Promise<void> {
  for (const f of store.t.files) {
    const c = f.content;
    if (f.regen || c.type !== 'bytes' || saved.has(f.id)) continue;
    await blobs.put(f.id, c.data);
    for (const [k, v] of Object.entries(c.variants ?? {})) await blobs.put(`${f.id}:${k}`, v);
    saved.add(f.id);
  }
}

export function serialize(store: Store, inBlobs: Set<string> = new Set()): string {
  const files = store.t.files.map((f) => {
    const c = f.content;
    let content: WireContent;
    if (c.type !== 'bytes') content = c;
    else if (f.regen) content = { type: 'bytes', data: '' };
    else if (inBlobs.has(f.id)) content = { type: 'blob' };
    else
      content = {
        type: 'bytes',
        data: toBase64(c.data),
        ...(c.variants && { variants: Object.fromEntries(Object.entries(c.variants).map(([k, v]) => [k, toBase64(v)])) }),
      };
    return { ...f, content };
  });
  const snapshot: Snapshot = {
    format: FORMAT,
    t: { ...store.t, files: files as unknown as FileRow[] },
    kv: [...store.kv],
    seq: store.seq,
    cookies: [...store.cookies],
    epoch: store.epoch,
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
  if (s?.format !== FORMAT) return null;
  const store = new Store(clock);
  const files = (s.t.files as unknown as (Omit<FileRow, 'content'> & { content: WireContent })[]).map((f) => {
    const c = f.content;
    const content: FileRow['content'] =
      c.type !== 'bytes'
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
  if (s.epoch) store.epoch = s.epoch;
  store.reindex();
  return store;
}

export class SharedState {
  private version: string | null = null;
  private lastJson: string | null = null;
  private readonly inBlobs = new Set<string>();

  constructor(
    private readonly storage: Storage,
    private readonly blobs: BlobStore | null,
    private readonly clock: () => number,
    private readonly key = SNAPSHOT_KEY,
  ) {}

  get versionKey(): string {
    return `${this.key}:version`;
  }

  loadIfChanged(): Store | null {
    const version = this.storage.getItem(this.versionKey);
    if (version === null || version === this.version) return null;
    const json = this.storage.getItem(this.key);
    const store = json ? deserialize(json, this.clock) : null;
    this.version = version;
    this.lastJson = json;
    this.inBlobs.clear();
    if (store) for (const f of store.t.files) if (f.content.type === 'blob') this.inBlobs.add(f.id);
    return store;
  }

  async save(store: Store, verify = false): Promise<void> {
    if (!store.dirty && this.lastJson !== null) {
      if (verify && serialize(store, this.inBlobs) !== this.lastJson) throw new Error('mock-api: the state changed but Store.dirty was not set');
      return;
    }
    if (this.blobs) await storeBlobs(store, this.blobs, this.inBlobs);
    const json = serialize(store, this.inBlobs);
    if (json === this.lastJson) {
      store.dirty = false;
      return;
    }
    const version = hex(randomBytes(8));
    this.storage.setItem(this.key, json);
    this.storage.setItem(this.versionKey, version);
    store.dirty = false;
    this.version = version;
    this.lastJson = json;
  }

  async clear(): Promise<void> {
    this.storage.removeItem(this.key);
    this.storage.removeItem(this.versionKey);
    this.version = null;
    this.lastJson = null;
    this.inBlobs.clear();
    await this.blobs?.clear();
  }
}

export function indexedDbBlobs(name = 'agrotrace-mock-api'): BlobStore | null {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> =>
    (db ??= new Promise((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await open();
    return new Promise<T>((resolve, reject) => {
      const r = fn(d.transaction('files', mode).objectStore('files'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  };
  return {
    get: async (key) => {
      const v = await run<unknown>('readonly', (s) => s.get(key));
      return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : undefined;
    },
    put: async (key, bytes) => {
      await run('readwrite', (s) => s.put(bytes, key));
    },
    clear: async () => {
      await run('readwrite', (s) => s.clear());
    },
  };
}
