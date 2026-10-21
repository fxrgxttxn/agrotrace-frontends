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
    // The bundled contract and swagger-ui-dist (Dockerfile stage `contract`); unset → resources/ of the image, then the
    // repository's contracts/dist/openapi.json (`./at.sh pnpm --filter @agrotrace/contracts bundle`).
    'contract_path' => env('CONTRACT_PATH'),
    'swagger_path' => env('SWAGGER_UI_PATH'),
];
