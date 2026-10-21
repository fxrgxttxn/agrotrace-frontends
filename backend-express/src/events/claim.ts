/**
 * The consumer's first statement (R56, contracts/events/envelope.schema.json): `INSERT INTO processed_events …
 * ON CONFLICT DO NOTHING` inside the handler's transaction. false — the event was already handled (a redelivery, or
 * the same event handled by a parallel consumer that committed first): the handler writes nothing.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../db/types.generated.js';

export async function claimEvent(tx: Transaction<DB>, eventId: string): Promise<boolean> {
  const r = await tx
    .insertInto('processed_events')
    .values({ event_id: eventId, backend: 'express' })
    .onConflict((oc) => oc.column('event_id').doNothing())
    .returning('event_id')
    .executeTakeFirst();
  return r !== undefined;
}
