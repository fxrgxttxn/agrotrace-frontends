export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH';

export interface OperationMeta {
  operationId: string;
  method: HttpMethod;
  path: string;
  roles: string[];
  orgAdmin: boolean;
  idempotent: boolean;
  rateLimit: string[];
  bearer: boolean;
  signedAccess: boolean;
  sort?: { fields: string[]; default: string };
  reportAccess?: Record<string, { roles: string[]; headRoles: string[] }>;
}
