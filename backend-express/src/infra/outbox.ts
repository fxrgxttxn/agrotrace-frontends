/**
 * Transactional outbox, write side (R55, R56, P1): an event is a row of `outbox_events` inserted in the SAME transaction
 * as the state change that causes it; the relay (after commit) and the sweeper publish it later (Task 12). The row's
 * `payload` is the whole queue document of contracts/events/envelope.schema.json.
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { currentRequestId } from '../context.js';
import type { DB } from '../db/types.generated.js';

/** contracts/events/envelope.schema.json#/properties/type/enum */
export type EventType =
  'recall.requested' | 'notification.dispatch' | 'lab.escalate' | 'rating.recalculate' | 'vsd.import';

export interface EventEnvelope<T extends EventType = EventType> {
  id: string;
  type: T;
  occurredAt: string;
  backend: 'express';
  requestId: string | null;
  data: Record<string, unknown>;
}

export interface EnqueueOptions<T extends EventType> {
  type: T;
  /** `data` of the event (its own schema, contracts/events/<type>.schema.json). */
  payload: Record<string, unknown>;
  /** Defaults to the current request's id; null for scheduler jobs; a worker passes the handled event's requestId. */
  requestId?: string | null;
  /** Clock (tests). */
  now?: () => Date;
}

/** Writes the event into the outbox inside `tx` and returns the envelope (id = outbox_events.id = AMQP message_id). */
export async function enqueue<T extends EventType>(
  tx: Transaction<DB>,
  opts: EnqueueOptions<T>,
): Promise<EventEnvelope<T>> {
  const envelope: EventEnvelope<T> = {
    id: randomUUID(),
    type: opts.type,
    // R59: the clock time of the INSERT, inside the causing transaction.
    occurredAt: (opts.now?.() ?? new Date()).toISOString(),
    backend: 'express',
    requestId: opts.requestId !== undefined ? opts.requestId : currentRequestId(),
    data: opts.payload,
  };
  await tx
    .insertInto('outbox_events')
    .values({ id: envelope.id, backend: 'express', type: envelope.type, payload: JSON.stringify(envelope) })
    .execute();
  return envelope;
}
