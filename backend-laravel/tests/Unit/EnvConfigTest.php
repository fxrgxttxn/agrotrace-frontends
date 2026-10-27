<?php

/*
 * Process start (P61, port notes): an invalid environment or a connection budget over 20 (DB_SLOTS + 1 + 3 + 4) stops
 * every process with exit code 78 and one line per problem.
 */

use App\Support\EnvConfig;
use Tests\TestCase;

uses(TestCase::class);

function validEnv(array $over = []): array
{
    return [
        'APP_KEY' => 'base64:'.base64_encode(str_repeat('k', 32)),
        'APP_DATABASE_URL' => 'postgres://agrotrace_app:pw@postgres:5432/agrotrace',
        'REDIS_URL' => 'redis://redis:6379/0',
        'RABBITMQ_URL' => 'amqp://u:p@rabbitmq:5672/',
        'S3_ENDPOINT' => 'http://minio:9000',
        'S3_ACCESS_KEY' => 'a', 'S3_SECRET_KEY' => 'b', 'S3_BUCKET' => 'agrotrace',
        'JWT_SECRET' => str_repeat('s', 32),
        'PUBLIC_BASE_URL' => 'http://react-laravel.localhost:8088',
        'DB_SLOTS' => '11', 'OCTANE_WORKERS' => '32', 'AGROTRACE_PROCESS' => 'api',
        ...$over,
    ];
}

it('accepts the stand configuration (19 connections)', function () {
    expect(EnvConfig::problems(validEnv()))->toBe([]);
    expect(EnvConfig::problems(validEnv(['DB_SLOTS' => '12'])))->toBe([]); // 12 + 8 = 20
});

it('refuses a budget over 20 connections', function () {
    $p = EnvConfig::problems(validEnv(['DB_SLOTS' => '13']));
    expect($p)->toHaveCount(1);
    expect($p[0])->toContain('DB_SLOTS')->toContain('21');
});

it('lists every invalid variable', function () {
    $p = EnvConfig::problems(validEnv([
        'APP_DATABASE_URL' => 'mysql://x', 'JWT_SECRET' => 'short', 'OCTANE_WORKERS' => 'many',
        'RATE_LIMIT_OVERRIDES' => '{"user":0}', 'APP_KEY' => false,
    ]));
    expect($p)->toHaveCount(5);
    expect(EnvConfig::problems(validEnv(['RATE_LIMIT_OVERRIDES' => '{"user":100000,"login-ip":100000,"complaint-ip":100000}'])))->toBe([]);
    expect(EnvConfig::problems(validEnv(['RATE_LIMIT_OVERRIDES' => 'nope'])))->toHaveCount(1);
});

it('exits 78 from artisan agrotrace:preflight', function () {
    $env = validEnv(['DB_SLOTS' => '20']);
    $cmd = 'cd '.escapeshellarg(base_path()).' && env -i PATH="$PATH" '
        .implode(' ', array_map(fn ($k, $v) => $k.'='.escapeshellarg((string) $v), array_keys($env), $env))
        .' php artisan agrotrace:preflight 2>&1';
    exec($cmd, $out, $code);
    expect($code)->toBe(78);
    expect(implode("\n", $out))->toContain('invalid configuration')->toContain('DB_SLOTS');
});

it('refuses to start api-laravel without APCu (the SSE stream caps), other processes do not need it', function () {
    $p = EnvConfig::problems(validEnv(), apcu: false);
    expect($p)->toHaveCount(1);
    expect($p[0])->toStartWith('APCu:');
    expect(EnvConfig::problems(validEnv(['AGROTRACE_PROCESS' => 'worker']), apcu: false))->toBe([]);
    expect(EnvConfig::problems(validEnv(), apcu: true))->toBe([]);
    expect(EnvConfig::problems(validEnv(['SSE_MAX_STREAMS_PER_USER' => '0'])))->toHaveCount(1);
});
