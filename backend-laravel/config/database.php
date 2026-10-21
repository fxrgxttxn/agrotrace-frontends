<?php

/*
 * PostgreSQL (port-globals §1, SP7): every process connects as `agrotrace_app` from APP_DATABASE_URL — DATABASE_URL
 * (the owner) is never read by the application. The pgsql connector is App\Infrastructure\Db\PgConnector (bound in
 * AppServiceProvider): a DbSlots slot first, then the connection (connect_timeout 5 s), then the session settings
 * (statement_timeout 30 s, lock_timeout 10 s, TimeZone UTC) — P61, L4.
 *
 * Redis (SP7): no key prefix, no serializer, no compression — the keys of the contract table are shared by the three
 * backends byte for byte (`idem:`, `rl:`, `pub:batch:`, …).
 */
return [
    'default' => 'pgsql',
    'connections' => [
        'pgsql' => [
            'driver' => 'pgsql',
            'url' => env('APP_DATABASE_URL'),
            'charset' => 'utf8',
            'prefix' => '',
            'prefix_indexes' => true,
            'search_path' => 'public',
            'sslmode' => 'prefer',
            'timezone' => 'UTC',
            'application_name' => 'agrotrace-laravel-'.env('AGROTRACE_PROCESS', 'cli'),
            'options' => [PDO::ATTR_TIMEOUT => 5],
        ],
    ],
    'migrations' => ['table' => 'schema_migrations', 'update_date_on_publish' => false],
    'redis' => [
        'client' => 'phpredis',
        'options' => [
            'cluster' => 'redis',
            'prefix' => '', // never env('REDIS_PREFIX'): no prefix on any connection (SP7)
            'persistent' => false,
        ],
        'default' => [
            'url' => env('REDIS_URL', 'redis://redis:6379/0'),
            'prefix' => '', // never env('REDIS_PREFIX'): no prefix on any connection (SP7)
            'timeout' => 2.0,
            'read_timeout' => 5.0,
        ],
    ],
];
