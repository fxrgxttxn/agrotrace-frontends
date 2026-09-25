/**
 * Process configuration: the environment (docker-compose `env_file: .env` + service `environment`), validated once
 * at start. A missing or malformed variable stops the process with one line per problem — never a half-configured
 * server.
 */
import { z } from 'zod';
import rateLimits from '../../contracts/rules/rate-limits.json' with { type: 'json' };

const RATE_SCOPES = rateLimits.limits.map((l) => l.scope) as [string, ...string[]];

const url = (protocols: string[]) =>
  z
    .string()
    .min(1)
    .refine(
      (s) => {
        try {
          return protocols.includes(new URL(s).protocol);
        } catch {
          return false;
        }
      },
      `must be a ${protocols.join(' or ')} URL`,
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Least-privilege role `agrotrace_app` (infra/postgres/init). */
  APP_DATABASE_URL: url(['postgres:', 'postgresql:']),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  REDIS_URL: url(['redis:', 'rediss:']),
  RABBITMQ_URL: url(['amqp:', 'amqps:']),
  S3_ENDPOINT: url(['http:', 'https:']),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Links in letters: `${PUBLIC_BASE_URL}/password/reset/{token}`, `${PUBLIC_BASE_URL}/invite/{token}` (R82). */
  PUBLIC_BASE_URL: url(['http:', 'https:']).transform((s) => s.replace(/\/+$/, '')),
  /** Outgoing mail (dev: Mailpit). */
  SMTP_HOST: z.string().min(1).default('mailpit'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_FROM: z.string().min(3).default('AgroTrace <noreply@agrotrace.local>'),
  /** DaData (organization lookup by INN). Unset → registration goes to MANUAL_CHECK without calling it. */
  DADATA_API_KEY: z.string().min(1).optional(),
  DADATA_URL: url(['http:', 'https:']).default(
    'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party',
  ),
  /**
   * P10 (contract info.description, deployment configuration): JSON `{"<scope>": <limit>}` replacing the `limit` of
   * scopes from contracts/rules/rate-limits.json. Test stand only (compose profile api-test); unset in operation.
   */
  RATE_LIMIT_OVERRIDES: z
    .string()
    .optional()
    .transform((s, ctx): Record<string, number> => {
      if (s === undefined) return {};
      let v: unknown;
      try {
        v = JSON.parse(s);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a JSON object {"<scope>": <limit>}' });
        return z.NEVER;
      }
      const r = z.record(z.enum(RATE_SCOPES), z.number().int().min(1)).safeParse(v);
      if (!r.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must map scopes (${RATE_SCOPES.join(', ')}) to integers >= 1`,
        });
        return z.NEVER;
      }
      return r.data;
    }),
  DADATA_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(3000),
  /** Readiness checks give up after this long (each dependency). */
  HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(2000),
  /** Graceful shutdown: in-flight requests get this long after SIGTERM. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(120000).default(10000),
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parses the environment; throws ConfigError listing every problem (variable: message). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty strings count as unset (docker-compose passes `VAR=` from .env as "").
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const r = schema.safeParse(cleaned);
  if (r.success) return r.data;
  throw new ConfigError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
}
