<?php

/*
 * LocalGate (review M5 of Tasks 4+5): the container-wide mutex importDictionary waits on with no DB slot held, so
 * parallel imports of one dictionary cannot starve DB_SLOTS while they queue for its advisory lock. Another holder is
 * a separate PHP process that flocks the gate file.
 */

use App\Infrastructure\Db\LocalGate;
use Tests\TestCase;

uses(TestCase::class);

function gateDir(): string
{
    return sys_get_temp_dir().'/agrotrace-gates-test-'.getmypid();
}

it('runs the work and returns its result', function () {
    expect(LocalGate::run('k', fn () => 42, gateDir()))->toBe(42);
});

it('waits while another process holds the gate, then runs', function () {
    $dir = gateDir();
    @mkdir($dir, 0777, true);
    $file = $dir.'/'.hash('sha256', 'held').'.lock';
    $holder = proc_open(
        [PHP_BINARY, '-r', '$h = fopen($argv[1], "c"); flock($h, LOCK_EX); echo "held\n"; usleep(400000);', $file],
        [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']],
        $pipes,
    );
    expect(fgets($pipes[1]))->toBe("held\n");
    $started = microtime(true);
    expect(LocalGate::run('held', fn () => 'ran', $dir))->toBe('ran');
    expect(microtime(true) - $started)->toBeGreaterThan(0.25);
    fclose($pipes[1]);
    proc_close($holder);
    // Released again: the next run does not wait.
    $started = microtime(true);
    LocalGate::run('held', fn () => null, $dir);
    expect(microtime(true) - $started)->toBeLessThan(0.1);
});

it('a failing work releases the gate', function () {
    expect(fn () => LocalGate::run('fails', fn () => throw new RuntimeException('boom'), gateDir()))->toThrow(RuntimeException::class);
    $started = microtime(true);
    LocalGate::run('fails', fn () => null, gateDir());
    expect(microtime(true) - $started)->toBeLessThan(0.1);
});
