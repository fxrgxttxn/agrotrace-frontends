<?php

/*
 * The PostgreSQL connection budget of the implementation (P61, L4; contract «Бюджет соединений»): with the default
 * configuration DB_SLOTS 11 (api) + 1 (the SSE hub's LISTEN) + 3 (the worker's two consumers and the Telegram poller)
 * + 4 (one per scheduler job process) = 19 ≤ 20. The fixed part is counted from the process definitions themselves,
 * so a new DB-holding process cannot be added without the budget seeing it.
 */

use App\Support\EnvConfig;
use Tests\TestCase;

uses(TestCase::class);

/** @return array<string, int> the [program:…] names of a supervisord config → their process count (numprocs) */
function programs(string $file): array
{
    $out = [];
    foreach (preg_split('/^(?=\[program:)/m', (string) file_get_contents(base_path($file))) as $section) {
        if (preg_match('/^\[program:([a-z0-9-]+)\]$/m', $section, $name)) {
            $out[$name[1]] = preg_match('/^numprocs=(\d+)$/m', $section, $n) ? (int) $n[1] : 1;
        }
    }

    return $out;
}

it('the default budget is 11 + 1 + 3 + 4 = 19 ≤ 20', function () {
    $compose = (string) file_get_contents(base_path('../docker-compose.yml'));
    preg_match_all('/^\s+DB_SLOTS: \$\{DB_SLOTS:-(\d+)\}$/m', $compose, $m);
    expect($m[1])->toBe(['11', '11', '11']); // api-laravel, worker-laravel, scheduler-laravel
    expect(config('agrotrace.db.slots'))->toBe(11);

    // api: the relay shares the DB_SLOTS slots (DB_SLOTS_ENABLED=true); the SSE hub holds its own LISTEN session.
    expect(programs('docker/supervisord-api.conf'))->toBe(['frankenphp' => 1, 'haproxy' => 1, 'relay' => 1, 'sse-hub' => 1]);
    $hub = programs('docker/supervisord-api.conf')['sse-hub'];
    // worker: 2 × consume + telegram-poll; scheduler: one process per job. Each holds one connection.
    $worker = array_sum(programs('docker/supervisord-worker.conf'));
    $scheduler = array_sum(programs('docker/supervisord-scheduler.conf'));
    expect($worker)->toBe(3)->and($scheduler)->toBe(4);

    expect(EnvConfig::FIXED_CONNECTIONS)->toBe($hub + $worker + $scheduler);
    expect(11 + EnvConfig::FIXED_CONNECTIONS)->toBe(19)->toBeLessThanOrEqual(EnvConfig::BUDGET);
    expect(EnvConfig::BUDGET)->toBe(20);
});

it('the contract states the same Laravel budget (P61 paragraph, SP4)', function () {
    $contract = (string) file_get_contents(base_path('../contracts/openapi.yaml'));
    expect(preg_replace('/\s+/', ' ', $contract))->toContain('в сумме ≤ 20 (на стенде 11 + 1 + 3 + 4 = 19)');
});
