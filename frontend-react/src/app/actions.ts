// The person's own actions (rulings FM26 clarification, FM30). The focus rescue (focusRescue.ts) moves the focus only
// right after the person's own press or the answer of a request their action started — never merely while such a
// request is pending (a stalled request does not keep the window open), and never after a passive refresh: requests
// started by a live-event invalidation are passive, and a passive answer after the last own step closes the window.
// No dependencies.

/** A request that starts this soon after a press belongs to it. */
const START_MS = 1000;
/** A request that starts this soon after an own answer is chained to the same action. */
const CHAIN_MS = 150;
/** A removal this soon after an own answer belongs to the action (its render). */
const ANSWER_MS = 500;

let inputAt = -Infinity;
let ownAnswerAt = -Infinity;
let passiveAt = -Infinity;
let passive = false;

const now = () => performance.now();

/** A key or pointer press of the person. */
export function noteInput(): void {
  inputAt = now();
}

/** Runs `fn` (an invalidation of a live event): the requests it starts are passive, not the person's. */
export function runPassive(fn: () => void): void {
  const was = passive;
  passive = true;
  try {
    fn();
  } finally {
    // The query functions start their requests after a microtask or two: the mark lasts until the next task.
    setTimeout(() => {
      passive = was;
    }, 0);
  }
}

/** Whether the focus rescue may act now: right after an own press or an own answer, with no passive answer since. */
export function rescueWindow(): boolean {
  const t = now();
  const pressed = t - inputAt < START_MS && inputAt > passiveAt;
  const answered = t - ownAnswerAt < ANSWER_MS && ownAnswerAt > passiveAt;
  return pressed || answered;
}

/** Runs a request, counting it to the person's action when it starts within one (chained requests included). */
export async function trackRequest<T>(run: () => Promise<T>): Promise<T> {
  const t = now();
  const wasPassive = passive;
  const own = !wasPassive && (t - inputAt < START_MS || t - ownAnswerAt < CHAIN_MS);
  try {
    return await run();
  } finally {
    if (own) ownAnswerAt = now();
    else if (wasPassive) passiveAt = now();
  }
}
