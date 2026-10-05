import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import type { OperationMeta } from '../src/contract/types.js';

const ROOT = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../../contracts/redocly.yaml', import.meta.url));
const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export async function bundledContract(): Promise<Json> {
  const config = await loadConfig({ configPath: CONFIG });
  return (await bundle({ ref: ROOT, config })).bundle.parsed as Json;
}

export async function operationTable(doc?: Json): Promise<OperationMeta[]> {
  const contract = doc ?? (await bundledContract());
  const out: OperationMeta[] = [];
  for (const [path, item] of Object.entries<Json>(contract.paths)) {
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const security = (op.security ?? contract.security) as Json[];
      const meta: OperationMeta = {
        operationId: op.operationId,
        method: method.toUpperCase() as OperationMeta['method'],
        path,
        roles: op['x-roles'] ?? [],
        orgAdmin: op['x-org-admin'] === true,
        idempotent: op['x-idempotent'] === true,
        rateLimit: op['x-rate-limit'] ?? [],
        bearer: security.some((s) => 'bearer' in s),
        signedAccess: op['x-access'] === 'signed',
      };
      if (op['x-sort']) meta.sort = { fields: op['x-sort'].fields, default: op['x-sort'].default };
      if (op['x-report-access']) meta.reportAccess = op['x-report-access'];
      out.push(meta);
    }
  }
  return out;
}
