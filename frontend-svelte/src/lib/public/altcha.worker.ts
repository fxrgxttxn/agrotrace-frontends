import { answer, type Challenge } from './pow';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Challenge>) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = (e) => scope.postMessage({ payload: answer(e.data) });
