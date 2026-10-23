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
    // The broker fails fast (connect + handshake + channel RPCs) and confirms are bounded (Express: 10 s), Task 6.
    'amqp' => [
        'connect_timeout_sec' => (float) env('AMQP_CONNECT_TIMEOUT_SEC', 2.0),
        'read_write_timeout_sec' => 10.0,
        'confirm_timeout_sec' => (float) env('AMQP_CONFIRM_TIMEOUT_SEC', 10.0),
    ],
    // The api container's relay process (agrotrace:relay) and the Octane workers' hand-off to it (RelayNotifier).
    'relay' => [
        'socket' => env('RELAY_SOCKET', '/tmp/agrotrace-relay.sock'),
        // Touched by a sender whose hand-off failed: the relay then catches up from the outbox (RelayLoop).
        'dropped_marker' => env('RELAY_DROPPED_MARKER', '/tmp/agrotrace-relay.dropped'),
    ],
    // At most one vsd.import handler per worker container (L2).
    'vsd_lock' => env('VSD_LOCK_FILE', '/tmp/agrotrace-vsd.lock'),
    // ФГИС «Меркурий» (R81; P35: the test-stand knobs of the worker).
    'mercury' => [
        'url' => env('MERCURY_URL', 'http://mercury-mock:8080'),
        'timeout_ms' => (int) env('MERCURY_TIMEOUT_MS', 10000),
        'retry_base_ms' => (int) env('MERCURY_RETRY_BASE_MS', 2000),
        'fail_product_codes' => (string) env('MERCURY_FAIL_PRODUCT_CODES', ''),
        'fail_mode' => env('MERCURY_FAIL_MODE', '500'),
    ],
    // createBatchQr: the bounded render lane and the label's fonts (@fontsource WOFF → TCPDF font files).
    'qr' => [
        'render_slots' => (int) env('QR_RENDER_SLOTS', 2),
        'render_dir' => env('QR_RENDER_DIR', '/tmp/agrotrace-qr-render'),
    ],
    'pdf' => [
        'fonts_dir' => env('PDF_FONTS_DIR'),
        'font_cache' => env('PDF_FONT_CACHE', sys_get_temp_dir().'/agrotrace-fonts'),
    ],
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
