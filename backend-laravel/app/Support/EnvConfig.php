<?php

namespace App\Support;

use App\Contract\RulesRepo;
use App\Scheduler\Tick;
use App\Scheduler\TickConfigError;
use Throwable;

/**
 * Validation of the process environment at start (`artisan agrotrace:preflight`, run by docker/entrypoint.sh before
 * every process): any problem stops the process with exit code 78 (EX_CONFIG) and one line per problem — never a
 * half-configured server. Includes the connection budget of the implementation (P61, L4): DB_SLOTS + 1 (SSE hub
 * LISTEN) + 3 (worker: 2 consumers + Telegram poller) + 4 (scheduler job processes) ≤ 20.
 */
final class EnvConfig
{
    public const EXIT_CONFIG = 78;

    public const BUDGET = 20;

    public const FIXED_CONNECTIONS = 1 + 3 + 4;

    public const PROCESSES = ['api', 'relay', 'worker', 'scheduler', 'cli', 'test'];

    /**
     * @param  array<string, string|false|null>  $env  variable → value (false/null = unset)
     * @return list<string>
     */
    public static function problems(array $env): array
    {
        $p = [];
        $get = fn (string $k): ?string => isset($env[$k]) && $env[$k] !== false ? (string) $env[$k] : null;

        $key = $get('APP_KEY');
        if ($key === null || ! str_starts_with($key, 'base64:') || strlen((string) base64_decode(substr($key, 7), true)) !== 32) {
            $p[] = 'APP_KEY: must be base64:<32 random bytes> (compose: ${LARAVEL_APP_KEY})';
        }
        self::url($p, 'APP_DATABASE_URL', $get('APP_DATABASE_URL'), ['postgres', 'postgresql']);
        self::url($p, 'REDIS_URL', $get('REDIS_URL'), ['redis', 'rediss']);
        self::url($p, 'RABBITMQ_URL', $get('RABBITMQ_URL'), ['amqp', 'amqps']);
        self::url($p, 'S3_ENDPOINT', $get('S3_ENDPOINT'), ['http', 'https']);
        self::url($p, 'PUBLIC_BASE_URL', $get('PUBLIC_BASE_URL'), ['http', 'https']);
        foreach (['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET'] as $k) {
            if (($get($k) ?? '') === '') {
                $p[] = "{$k}: must be set";
            }
        }
        if (strlen($get('JWT_SECRET') ?? '') < 32) {
            $p[] = 'JWT_SECRET: must be at least 32 characters';
        }
        $slots = self::int($p, 'DB_SLOTS', $get('DB_SLOTS'), 11, 1, 100);
        if ($slots !== null && $slots + self::FIXED_CONNECTIONS > self::BUDGET) {
            $p[] = sprintf(
                'DB_SLOTS: the connection budget is %d per implementation (P61) — DB_SLOTS %d + %d (SSE hub 1, worker 3, scheduler 4) = %d',
                self::BUDGET, $slots, self::FIXED_CONNECTIONS, $slots + self::FIXED_CONNECTIONS,
            );
        }
        self::int($p, 'OCTANE_WORKERS', $get('OCTANE_WORKERS'), 32, 1, 1024);
        self::int($p, 'HEALTH_TIMEOUT_MS', $get('HEALTH_TIMEOUT_MS'), 2000, 100, 30000);
        // L5: a period the Scheduler can express (App\Scheduler\Tick, the port's deviation from Express's 100…3 600 000).
        $tick = self::int($p, 'SCHEDULER_TICK_MS', $get('SCHEDULER_TICK_MS'), Tick::DEFAULT_MS, 100, 3_600_000);
        if ($tick !== null) {
            try {
                Tick::frequency($tick);
            } catch (TickConfigError $e) {
                $p[] = $e->getMessage();
            }
        }
        $process = $get('AGROTRACE_PROCESS') ?? 'cli';
        if (! in_array($process, self::PROCESSES, true)) {
            $p[] = 'AGROTRACE_PROCESS: must be one of '.implode(', ', self::PROCESSES);
        }
        $level = $get('LOG_LEVEL');
        if ($level !== null && ! in_array($level, ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'], true)) {
            $p[] = 'LOG_LEVEL: must be a PSR-3 level (debug, info, warning, error, …)';
        }
        self::rateLimitOverrides($p, $get('RATE_LIMIT_OVERRIDES'));
        $bot = $get('TELEGRAM_BOT_USERNAME');
        if ($bot !== null && $bot !== '' && preg_match('/^[A-Za-z0-9_]{5,32}$/D', $bot) !== 1) {
            $p[] = 'TELEGRAM_BOT_USERNAME: must be a Telegram username without @ (5-32 of A-Z a-z 0-9 _)';
        }
        // ФГИС «Меркурий» and the test-stand knobs of the worker (P35), as Express's config validates them.
        if ($get('MERCURY_URL') !== null && $get('MERCURY_URL') !== '') {
            self::url($p, 'MERCURY_URL', $get('MERCURY_URL'), ['http', 'https']);
        }
        self::int($p, 'MERCURY_TIMEOUT_MS', $get('MERCURY_TIMEOUT_MS'), 10000, 100, 60000);
        self::int($p, 'MERCURY_RETRY_BASE_MS', $get('MERCURY_RETRY_BASE_MS'), 2000, 1, 60000);
        $failMode = $get('MERCURY_FAIL_MODE');
        if ($failMode !== null && $failMode !== '' && ! in_array($failMode, ['500', 'timeout'], true)) {
            $p[] = 'MERCURY_FAIL_MODE: must be 500 or timeout';
        }
        $smtpPort = $get('SMTP_PORT');
        if ($smtpPort !== null && $smtpPort !== '') {
            self::int($p, 'SMTP_PORT', $smtpPort, 1025, 1, 65535);
        }

        return $p;
    }

    /**
     * @param  list<string>  $p
     * @param  list<string>  $schemes
     */
    private static function url(array &$p, string $name, ?string $value, array $schemes): void
    {
        $scheme = $value !== null ? parse_url($value, PHP_URL_SCHEME) : null;
        $host = $value !== null ? parse_url($value, PHP_URL_HOST) : null;
        if (! is_string($scheme) || ! in_array(strtolower($scheme), $schemes, true) || ! is_string($host) || $host === '') {
            $p[] = "{$name}: must be a ".implode(' or ', array_map(fn ($s) => "{$s}://", $schemes)).' URL';
        }
    }

    /** @param  list<string>  $p */
    private static function int(array &$p, string $name, ?string $value, int $default, int $min, int $max): ?int
    {
        if ($value === null || $value === '') {
            return $default;
        }
        if (! ctype_digit($value) || (int) $value < $min || (int) $value > $max) {
            $p[] = "{$name}: must be an integer {$min}..{$max}";

            return null;
        }

        return (int) $value;
    }

    /**
     * P10: JSON {"<scope>": <limit>} over the scopes of contracts/rules/rate-limits.json, integers ≥ 1.
     *
     * @param  list<string>  $p
     */
    private static function rateLimitOverrides(array &$p, ?string $value): void
    {
        if ($value === null || $value === '') {
            return;
        }
        try {
            $scopes = array_column(RulesRepo::json('rate-limits')['limits'], 'scope');
            $v = json_decode($value, false, 16, JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            $p[] = 'RATE_LIMIT_OVERRIDES: must be a JSON object {"<scope>": <limit>}';

            return;
        }
        if (! $v instanceof \stdClass) {
            $p[] = 'RATE_LIMIT_OVERRIDES: must be a JSON object {"<scope>": <limit>}';

            return;
        }
        foreach (get_object_vars($v) as $scope => $limit) {
            if (! in_array($scope, $scopes, true) || ! is_int($limit) || $limit < 1) {
                $p[] = 'RATE_LIMIT_OVERRIDES: must map scopes ('.implode(', ', $scopes).') to integers >= 1';

                return;
            }
        }
    }
}
