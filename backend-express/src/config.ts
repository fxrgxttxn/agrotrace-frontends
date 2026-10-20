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
  /**
   * Telegram bot (FR-NOTIF-02). Unset → createTelegramCode is 503 EXTERNAL_UNAVAILABLE {service: telegram}; the
   * username (without @) is what users are told to message with `/start <code>`.
   */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a Telegram username without @ (5-32 of A-Z a-z 0-9 _)')
    .default('agrotrace_bot'),
  /** ФГИС «Меркурий» (dev: mercury-mock), the `vsd.import` worker (R81, contracts/events/vsd.import.schema.json). */
  MERCURY_URL: url(['http:', 'https:'])
    .default('http://mercury-mock:8080')
    .transform((s) => s.replace(/\/+$/, '')),
  /** One Mercury call's timeout (the event schema: 10 s). */
  MERCURY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(10000),
  /**
   * The first retry delay; the next ones double (2, 4, 8, 16, 32 s by default — the event schema). Test stand only
   * (docker-compose.api-test.yml) shortens it so a FAILED import does not take a minute.
   */
  MERCURY_RETRY_BASE_MS: z.coerce.number().int().min(1).max(60000).default(2000),
  /**
   * Test stand only (docker-compose.api-test.yml): Mercury calls for these product codes (comma-separated
   * `products.mercury_code` values) carry `X-Mock-Fail: <MERCURY_FAIL_MODE>`, so mercury-mock fails them on purpose
   * and tests/api can watch an import end FAILED. Unset in operation.
   */
  MERCURY_FAIL_PRODUCT_CODES: z
    .string()
    .optional()
    .transform((s) =>
      (s ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  MERCURY_FAIL_MODE: z.enum(['500', 'timeout']).default('500'),
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
