/**
 * Per-request context (AsyncLocalStorage): the request id follows the request through awaits into the logger and the
 * outbox (`envelope.requestId`) without being passed around.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}
