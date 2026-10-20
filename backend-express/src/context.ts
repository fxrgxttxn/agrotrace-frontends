/**
 * Per-request context (AsyncLocalStorage): the request id and the client IP follow the request through awaits into
 * the logger, the outbox (`envelope.requestId`) and the audit log (`request_id`, `ip`) without being passed around.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  /** Client IP as the backend sees it behind the gateway (the last `X-Forwarded-For` hop); null if unknown. */
  ip: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

export function currentIp(): string | null {
  return storage.getStore()?.ip ?? null;
}
