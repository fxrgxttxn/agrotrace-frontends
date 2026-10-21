/**
 * `rating.recalculate` handler (worker; contracts/events/rating.recalculate.schema.json, BR-09): in ONE transaction
 * that starts with the processed_events claim, the farm's rating is recomputed from scratch under its row lock
 * (modules/rating/rating.ts). `cause` and `sourceId` are informational only.
 */
import type { Db } from '../../db/db.js';
import { withTx } from '../../db/tx.js';
import type { EventHandler } from '../../infra/consumer.js';
import { recalculateTrustRating } from '../../modules/rating/rating.js';
import { claimEvent } from '../claim.js';

export interface RatingRecalculateData {
  organizationId: string;
  cause: 'LAB_PASS' | 'LAB_FAIL' | 'RECALL_SOURCE';
  sourceId: string;
}

export function ratingRecalculateHandler(deps: { db: Db }): EventHandler {
  return async (event) => {
    const data = event.data as unknown as RatingRecalculateData;
    await withTx(deps.db, async (tx) => {
      if (!(await claimEvent(tx, event.id))) return;
      await recalculateTrustRating(tx, data.organizationId);
    });
  };
}
