import type { GlobalSetupContext } from 'vitest/node';
import { bundledContract } from '../scripts/contract-table.js';

// Bundles contracts/openapi.yaml once per run; test files get it through `inject('contract')`.
export default async function setup({ provide }: GlobalSetupContext) {
  provide('contract', await bundledContract());
}

declare module 'vitest' {
  export interface ProvidedContext {
    contract: Record<string, unknown>;
  }
}
