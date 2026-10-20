import { answer, type Challenge } from './pow';

// The ALTCHA proof of work off the main thread (a same-origin file: CSP `script-src 'self'` covers the worker).
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Challenge>) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = (e) => scope.postMessage({ payload: answer(e.data) });
