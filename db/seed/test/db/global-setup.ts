/**
 * Seeds the dev database once before the DB tests, with SEED_NOW from the environment or the current
 * minute (R73), and hands that moment to the tests (`inject('seedNow')`); the idempotency test seeds
 * again with the same SEED_NOW and compares.
 */
import type { GlobalSetupContext } from 'vitest/node';
import { envFromProcess, runSeed } from '../../src/seed';

export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const env = envFromProcess();
  await runSeed(env, (s) => console.log(s));
  provide('seedNow', env.seedNow);
}

declare module 'vitest' {
  export interface ProvidedContext {
    seedNow: string;
  }
}
