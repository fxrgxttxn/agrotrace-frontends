import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { answer, type Challenge } from '../../src/lib/public/pow';

export function challengeFor(
  number: number,
  maxnumber = 1000,
  salt = 'abc123?expires=4102444800',
): Challenge & {
  algorithm: 'SHA-256';
} {
  const challenge = createHash('sha256')
    .update(salt + number)
    .digest('hex');
  return { algorithm: 'SHA-256', challenge, salt, signature: 'f'.repeat(64), maxnumber };
}

export interface FakeWorker {
  url: string;
  terminated: boolean;
}

export function installWorker(mode: 'ok' | 'fail' = 'ok'): FakeWorker[] {
  const made: FakeWorker[] = [];
  class StandIn implements FakeWorker {
    url: string;
    terminated = false;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { preventDefault(): void }) => void) | null = null;
    constructor(url: URL | string) {
      this.url = String(url);
      made.push(this);
    }
    postMessage(c: Challenge) {
      setTimeout(() => {
        if (this.terminated) return;
        if (mode === 'fail') this.onerror?.({ preventDefault() {} });
        else this.onmessage?.({ data: { payload: answer(c) } });
      }, 5);
    }
    terminate() {
      this.terminated = true;
    }
  }
  vi.stubGlobal('Worker', StandIn);
  return made;
}
