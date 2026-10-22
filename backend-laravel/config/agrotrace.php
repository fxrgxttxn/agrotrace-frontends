<?php

/*
 * AgroTrace settings from the environment (docker-compose `env_file: .env` + the service `environment`). The raw
 * environment is validated at every process start by `artisan agrotrace:preflight` (docker/entrypoint.sh,
 * App\Support\EnvConfig): an invalid value stops the process with exit code 78 and one line per problem.
 */
return [
    'backend' => 'laravel',
    // api | worker | scheduler | cli | test — application_name `agrotrace-laravel-<process>`; DbSlots on api only.
    'process' => env('AGROTRACE_PROCESS', 'cli'),
    'db' => [
        // L4: PostgreSQL connections of the api container (Octane workers decoupled by flock slots), P61.
        'slots' => (int) env('DB_SLOTS', 11),
        'slots_enabled' => env('DB_SLOTS_ENABLED') !== null
            ? filter_var(env('DB_SLOTS_ENABLED'), FILTER_VALIDATE_BOOL)
            : env('AGROTRACE_PROCESS', 'cli') === 'api',
        'slots_dir' => env('DB_SLOTS_DIR', '/tmp/agrotrace-db-slots'),
        'slot_timeout' => 5.0,
        'statement_timeout' => '30s',
        'lock_timeout' => '10s',
    ],
    'rabbitmq_url' => env('RABBITMQ_URL', 'amqp://guest:guest@rabbitmq:5672/'),
    'exchange' => 'agrotrace.laravel',
    's3' => [
        'endpoint' => env('S3_ENDPOINT', 'http://minio:9000'),
        'key' => env('S3_ACCESS_KEY'),
        'secret' => env('S3_SECRET_KEY'),
        'bucket' => env('S3_BUCKET', 'agrotrace'),
        'region' => env('S3_REGION', 'us-east-1'),
    ],
    'health_timeout_ms' => (int) env('HEALTH_TIMEOUT_MS', 2000),
    // Access tokens and signed file URLs (R28, R88 M2, P12): one secret shared by the three backends.
    'jwt_secret' => (string) env('JWT_SECRET', ''),
    // Links in letters (R82): `${PUBLIC_BASE_URL}/password/reset/{token}`, `${PUBLIC_BASE_URL}/invite/{token}`.
    'public_base_url' => rtrim((string) env('PUBLIC_BASE_URL', 'http://localhost'), '/'),
    // P10: {"<scope>": <limit>} replacing limits of contracts/rules/rate-limits.json (the api-test profile only).
    'rate_limit_overrides' => env('RATE_LIMIT_OVERRIDES'),
    // Mail (spec 8.9): unset SMTP_HOST → mail is not configured (letters are logged as not delivered).
    'smtp' => [
        'host' => env('SMTP_HOST'),
        'port' => (int) env('SMTP_PORT', 1025),
        'from' => env('SMTP_FROM', 'AgroTrace <noreply@agrotrace.local>'),
    ],
    // DaData findById/party (FR-IAM-01): unset key → registration goes to MANUAL_CHECK without calling it.
    'dadata' => [
        'key' => env('DADATA_API_KEY'),
        'url' => env('DADATA_URL', 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party'),
        'timeout_ms' => (int) env('DADATA_TIMEOUT_MS', 3000),
    ],
    // Telegram (FR-NOTIF-02): unset token → createTelegramCode is 503 EXTERNAL_UNAVAILABLE {service: telegram}.
    'telegram' => [
        'token' => env('TELEGRAM_BOT_TOKEN'),
        'username' => env('TELEGRAM_BOT_USERNAME', 'agrotrace_bot'),
    ],
    // packages/i18n/locales/ru.json (the `mail.*` templates): a copy in the image, the repository's file in php-tools.
    'i18n_path' => env('I18N_PATH'),
    // Raster decoding (GD) bounded per container (Images/DecodeSlots, review M1): flock'ed slot files like DB_SLOTS. 4 =
    // libuv's default pool, Express's effective sharp concurrency; measured best of 2/4/8 for unrelated requests.
    'images' => [
        'decode_slots' => (int) env('IMAGE_DECODE_SLOTS', 4),
        'decode_slots_dir' => env('IMAGE_DECODE_SLOTS_DIR', '/tmp/agrotrace-decode-slots'),
    ],
    // L6: the sandbox lanes (flock slot files per container) and the PHP CLI that runs resources/sandbox/*.php.
    'sandbox' => [
        'dir' => env('SANDBOX_DIR', '/tmp/agrotrace-lanes'),
        'php' => env('SANDBOX_PHP', 'php'),
    ],
    // The bundled contract and swagger-ui-dist (Dockerfile stage `contract`); unset → resources/ of the image, then the
    // repository's contracts/dist/openapi.json (`./at.sh pnpm --filter @agrotrace/contracts bundle`).
    'contract_path' => env('CONTRACT_PATH'),
    'swagger_path' => env('SWAGGER_UI_PATH'),
];
