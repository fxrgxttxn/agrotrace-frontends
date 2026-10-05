import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import type { GlobalSetupContext } from 'vitest/node';

const ROOT = fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../contracts/redocly.yaml', import.meta.url));

export default async function setup({ provide }: GlobalSetupContext) {
  const config = await loadConfig({ configPath: CONFIG });
  const doc = (await bundle({ ref: ROOT, config })).bundle.parsed as Record<string, unknown>;
  provide('contract', doc);
}

declare module 'vitest' {
  export interface ProvidedContext {
    contract: Record<string, unknown>;
  }
}
