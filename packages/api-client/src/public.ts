import type { components, paths } from './schema';
import { ApiProblem, type ProblemBody } from './problem';

type Schemas = components['schemas'];
export type PublicBatch = Schemas['PublicBatch'];
export type PublicComplaintRequest = Schemas['PublicComplaintRequest'];
export type PublicComplaintCreated = Schemas['PublicComplaintCreated'];
export type AltchaChallenge = Schemas['AltchaChallenge'];
export type SafetyStatus = Schemas['SafetyStatus'];

export { ApiProblem } from './problem';
export type { ProblemBody } from './problem';
export { withVariant } from './variant';

export interface PublicApi {
  getBatch(publicCode: string, init?: { signal?: AbortSignal }): Promise<PublicBatch>;
  getCaptcha(init?: { signal?: AbortSignal }): Promise<AltchaChallenge>;
  createComplaint(publicCode: string, body: PublicComplaintRequest): Promise<PublicComplaintCreated>;
}

export interface CreatePublicApiOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

const RETRY_AFTER = new WeakMap<ApiProblem, number>();

export function retryAfterOf(problem: ApiProblem): number | null {
  return RETRY_AFTER.get(problem) ?? null;
}

type Op = keyof Pick<
  paths,
  '/public/batches/{publicCode}' | '/public/batches/{publicCode}/complaints' | '/public/captcha'
>;

export function createPublicApi(opts: CreatePublicApiOptions = {}): PublicApi {
  const base = opts.baseUrl ?? '/api/v1';
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(
    op: Op,
    params: Record<string, string>,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<T> {
    const path = op.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
    const headers = new Headers(init.headers);
    const { json, ...rest } = init;
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    const response = await doFetch(`${base}${path}`, {
      ...rest,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    if (response.ok) return (await response.json()) as T;
    let body: ProblemBody | null = null;
    try {
      const parsed = (await response.json()) as ProblemBody;
      if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') body = parsed;
    } catch {
      body = null;
    }
    const problem = body
      ? new ApiProblem(body, response.status)
      : ApiProblem.transient(response.statusText || 'Error', response.status);
    const retry = Number(response.headers.get('Retry-After'));
    if (Number.isFinite(retry) && retry > 0) RETRY_AFTER.set(problem, Math.ceil(retry));
    throw problem;
  }

  return {
    getBatch: (publicCode, init) =>
      request('/public/batches/{publicCode}', { publicCode }, { signal: init?.signal }),
    getCaptcha: (init) => request('/public/captcha', {}, { signal: init?.signal, cache: 'no-store' }),
    createComplaint: (publicCode, body) =>
      request('/public/batches/{publicCode}/complaints', { publicCode }, { method: 'POST', json: body }),
  };
}
