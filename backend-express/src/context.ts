/**
 * Per-request context (AsyncLocalStorage): the request id and the client IP follow the request through awaits into
 * the logger, the outbox (`envelope.requestId`) and the audit log (`request_id`, `ip`) without being passed around.
 * `events` collects the ids of the outbox rows the request wrote (infra/outbox.ts `enqueue`): the relay publishes
 * them right after the response (app.ts, R55/R56 "relay after commit"); ids of a rolled-back attempt name no row and
 * publish nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** The X-Request-Id of the request (audit `request_id`, outbox `requestId`); null in the worker (system entries). */
  requestId: string | null;
  /** Worker: the handled event's `requestId` — for log lines only (audit entries of the worker stay system: null). */
  eventRequestId?: string | null;
  /** Client IP as the backend sees it behind the gateway (the last `X-Forwarded-For` hop); null if unknown. */
  ip: string | null;
  /** Outbox event ids written while handling the request (published after the response). */
  events?: string[];
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

export function currentIp(): string | null {
  return storage.getStore()?.ip ?? null;
}

/** Records an outbox event id for the after-response relay (no-op outside a request). */
export function collectEvent(id: string): void {
  storage.getStore()?.events?.push(id);
}
