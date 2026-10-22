<?php

/*
 * LocalGate (review M5, re-review N1 of Tasks 4+5): the container-wide mutex importDictionary waits on with no DB slot
 * held — bounded like Express's wait for the same advisory lock: a deadline (the session's lock_timeout by default),
 * at most MAX_WAITERS waiters (one more is refused at once), and a client that went away leaves the queue without its
 * work ever running. Every refusal is BackendUnavailable (503 BACKEND_UNAVAILABLE, Express's answer to an exhausted
 * pool or an expired lock wait). Another holder is a separate PHP process that flocks the gate file.
 */

use App\Infrastructure\Db\BackendUnavailable;
use App\Infrastructure\Db\LocalGate;
use Tests\TestCase;

uses(TestCase::class);

function gateDir(): string
{
    $dir = sys_get_temp_dir().'/agrotrace-gates-test-'.getmypid();
    @mkdir($dir, 0777, true);

    return $dir;
}

function gateFile(string $key, string $suffix = 'lock'): string
{
    return gateDir().'/'.hash('sha256', $key).".{$suffix}";
}

/**
 * A separate process that holds $file for $ms (returns once it holds it).
 *
 * @return array{0: resource, 1: resource}
 */
function gateHolder(string $file, int $ms): array
{
    $proc = proc_open(
        [PHP_BINARY, '-r', '$h = fopen($argv[1], "c"); flock($h, LOCK_EX); echo "held\n"; usleep((int) $argv[2] * 1000);', $file, (string) $ms],
        [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']],
        $pipes,
    );
    expect(fgets($pipes[1]))->toBe("held\n");

    return [$proc, $pipes[1]];
}

/** @param  array{0: resource, 1: resource}  $holder */
function gateRelease(array $holder): void
{
    proc_terminate($holder[0], 9);
    fclose($holder[1]);
    proc_close($holder[0]);
}

/** Whether nobody holds $file (the gate or a waiting slot) — also not this process through another descriptor. */
function gateFree(string $file): bool
{
    $h = fopen($file, 'c');
    $free = flock($h, LOCK_EX | LOCK_NB);
    fclose($h);

    return $free;
}

function gateAllFree(string $key): void
{
    expect(gateFree(gateFile($key)))->toBeTrue();
    for ($i = 0; $i < LocalGate::MAX_WAITERS; $i++) {
        expect(gateFree(gateFile($key, "wait-{$i}.lock")))->toBeTrue();
    }
}

/** The outcome of a gated run: 'ran' or 'refused: <message>'. */
function gateOutcome(callable $run): string
{
    try {
        $run();

        return 'ran';
    } catch (BackendUnavailable $e) {
        return 'refused: '.$e->getMessage();
    }
}

it('runs the work and returns its result', function () {
    expect(LocalGate::run('k', fn () => 42, dir: gateDir()))->toBe(42);
    gateAllFree('k');
});

it('waits while another process holds the gate, then runs', function () {
    $holder = gateHolder(gateFile('held'), 400);
    $started = microtime(true);
    expect(LocalGate::run('held', fn () => 'ran', dir: gateDir()))->toBe('ran');
    expect(microtime(true) - $started)->toBeGreaterThan(0.25);
    gateRelease($holder);
    gateAllFree('held');
});

it('the wait ends at the deadline → BackendUnavailable; the work never runs', function () {
    $holder = gateHolder(gateFile('slow'), 3000);
    $ran = false;
    $started = microtime(true);
    expect(gateOutcome(fn () => LocalGate::run('slow', function () use (&$ran) {
        $ran = true;
    }, deadlineSec: 0.3, dir: gateDir())))->toBe('refused: gate slow: not free within the lock timeout');
    expect(microtime(true) - $started)->toBeGreaterThan(0.29)->toBeLessThan(0.8);
    gateRelease($holder);
    expect($ran)->toBeFalse();
    gateAllFree('slow');
});

it('the default deadline is the session lock_timeout (the advisory-lock wait\'s own budget)', function () {
    config(['agrotrace.db.lock_timeout' => '300ms']);
    $holder = gateHolder(gateFile('lt'), 3000);
    $started = microtime(true);
    expect(gateOutcome(fn () => LocalGate::run('lt', fn () => null, dir: gateDir())))->toStartWith('refused: ');
    expect(microtime(true) - $started)->toBeGreaterThan(0.29)->toBeLessThan(0.8);
    gateRelease($holder);
    gateAllFree('lt');
});

it('a client that goes away while waiting leaves the queue; its work never runs, not even once the gate frees', function () {
    $holder = gateHolder(gateFile('abort'), 3000);
    $polls = 0;
    $ran = false;
    $started = microtime(true);
    expect(gateOutcome(fn () => LocalGate::run('abort', function () use (&$ran) {
        $ran = true;
    }, clientGone: function () use (&$polls) {
        return ++$polls > 3;
    }, dir: gateDir())))->toBe('refused: gate abort: the client went away while waiting');
    expect(microtime(true) - $started)->toBeLessThan(0.5);
    gateRelease($holder);
    usleep(100_000);
    expect($ran)->toBeFalse();
    gateAllFree('abort');
});

it('a client gone by the time the gate is finally taken is not applied either', function () {
    $holder = gateHolder(gateFile('late'), 5000);
    $ran = false;
    $calls = 0;
    // Present for three polls; at the third the holder is killed (the gate frees), so the next check — the one made
    // once this process holds the gate — finds the client gone.
    $gone = function () use (&$calls, $holder): bool {
        if (++$calls === 3) {
            gateRelease($holder);
        }

        return $calls > 3;
    };
    expect(gateOutcome(fn () => LocalGate::run('late', function () use (&$ran) {
        $ran = true;
    }, clientGone: $gone, dir: gateDir())))->toBe('refused: gate late: the client went away while waiting');
    expect($calls)->toBe(4);
    expect($ran)->toBeFalse();
    gateAllFree('late');
});

it('at most MAX_WAITERS wait; one more is refused at once', function () {
    $holders = [gateHolder(gateFile('busy'), 5000)];
    for ($i = 0; $i < LocalGate::MAX_WAITERS; $i++) {
        $holders[] = gateHolder(gateFile('busy', "wait-{$i}.lock"), 5000);
    }
    $started = microtime(true);
    expect(gateOutcome(fn () => LocalGate::run('busy', fn () => null, dir: gateDir())))
        ->toBe('refused: gate busy: '.LocalGate::MAX_WAITERS.' requests already waiting');
    expect(microtime(true) - $started)->toBeLessThan(0.05);
    // A freed waiting slot admits a waiter again.
    gateRelease(array_pop($holders));
    expect(gateOutcome(fn () => LocalGate::run('busy', fn () => null, deadlineSec: 0.1, dir: gateDir())))
        ->toBe('refused: gate busy: not free within the lock timeout');
    foreach ($holders as $h) {
        gateRelease($h);
    }
    gateAllFree('busy');
});

it('a failing work releases the gate', function () {
    expect(fn () => LocalGate::run('fails', fn () => throw new RuntimeException('boom'), dir: gateDir()))->toThrow(RuntimeException::class);
    gateAllFree('fails');
});
