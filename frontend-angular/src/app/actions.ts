const START_MS = 1000;
const CHAIN_MS = 150;
const ANSWER_MS = 500;

let inputAt = -Infinity;
let ownAnswerAt = -Infinity;
let passiveAt = -Infinity;
let passiveDepth = 0;

const now = () => performance.now();

export function noteInput(): void {
  inputAt = now();
}

export function runPassive(fn: () => void): void {
  passiveDepth++;
  try {
    fn();
  } finally {
    setTimeout(() => {
      passiveDepth--;
    }, 0);
  }
}

export function rescueWindow(): boolean {
  const t = now();
  const pressed = t - inputAt < START_MS && inputAt > passiveAt;
  const answered = t - ownAnswerAt < ANSWER_MS && ownAnswerAt > passiveAt;
  return pressed || answered;
}

export async function trackRequest<T>(run: () => Promise<T>): Promise<T> {
  const t = now();
  const wasPassive = passiveDepth > 0;
  const own = !wasPassive && (t - inputAt < START_MS || t - ownAnswerAt < CHAIN_MS);
  try {
    return await run();
  } finally {
    if (own) ownAnswerAt = now();
    else if (wasPassive) passiveAt = now();
  }
}
