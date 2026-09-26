// The person's own actions (ruling FM26 clarification): an action runs from a key or pointer press to the answer of
// the requests it started — however long they take. The focus rescue (focusRescue.ts) acts only on a removal that
// belongs to such an action; a passive refresh (a live event, a timer) never moves the focus. No dependencies.

/** A request that starts this soon after a press belongs to it. */
const START_MS = 1000;
/** A removal this soon after the last own answer still belongs to the action (its render). */
const SETTLE_MS = 500;

let inputAt = -Infinity;
let pending = 0;
let endedAt = -Infinity;

const now = () => performance.now();

/** A key or pointer press of the person. */
export function noteInput(): void {
  inputAt = now();
}

/** Whether an own action is under way (just pressed, its requests running, or answered a moment ago). */
export function actionOpen(): boolean {
  const t = now();
  return t - inputAt < START_MS || pending > 0 || t - endedAt < SETTLE_MS;
}

/** Runs a request, counting it to the current action when it starts within one (chained requests included). */
export async function trackRequest<T>(run: () => Promise<T>): Promise<T> {
  if (!actionOpen()) return run();
  pending += 1;
  try {
    return await run();
  } finally {
    pending -= 1;
    endedAt = now();
  }
}
