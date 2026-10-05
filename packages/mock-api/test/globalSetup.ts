import type { GlobalSetupContext } from 'vitest/node';
import { bundledContract } from '../scripts/contract-table.js';

export default async function setup({ provide }: GlobalSetupContext) {
  provide('contract', await bundledContract());
}

declare module 'vitest' {
  export interface ProvidedContext {
    contract: Record<string, unknown>;
  }
}
