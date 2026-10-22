<?php

/*
 * The sandbox lane (L6, P18, P21) with a stub child (tests/Fixtures/sandbox/echo-after.php): a missed deadline kills
 * the child and the next job gets a fresh one; with 1 running + 8 waiting the 10th job is refused at once; the
 * deadline counts the waiting time but not the child's start-up; a waiting job of a client that went away leaves the
 * queue. Other holders are simulated by flock'ing the lane's slot files from the test (flock holds per open file).
 */

use App\Infrastructure\Sandbox\Lane;
use App\Infrastructure\Sandbox\LaneOptions;
use App\Infrastructure\Sandbox\LaneRefused;
use Tests\TestCase;

uses(TestCase::class);

function laneStub(): string
{
    return base_path('tests/Fixtures/sandbox/echo-after.php');
}

function laneOpts(float $deadline = 3.0, int $waiting = 8): LaneOptions
{
    return new LaneOptions('test-'.getmypid().'-'.bin2hex(random_bytes(3)), $waiting, $deadline, '64M', sys_get_temp_dir().'/agrotrace-lanes-test');
}

/** @return resource */
function holdSlot(LaneOptions $o, string $file)
{
    @mkdir($o->dir(), 0777, true);
    $h = fopen($o->dir()."/{$file}", 'c');
    expect(flock($h, LOCK_EX | LOCK_NB))->toBeTrue();

    return $h;
}

function laneRefusal(callable $run): ?string
{
    try {
        $run();
    } catch (LaneRefused $e) {
        return $e->reason;
    }

    return null;
}

afterEach(fn () => putenv('LANE_STUB_STARTUP_MS'));

it('runs a job in a child and returns its output', function () {
    expect(Lane::run(laneStub(), "0\nhello", laneOpts()))->toBe('<svg>hello</svg>');
});

it('a missed deadline kills the child; the next job gets a fresh child', function () {
    $o = laneOpts(0.3);
    $started = microtime(true);
    expect(laneRefusal(fn () => Lane::run(laneStub(), "-1\nhang", $o)))->toBe('too-complex');
    expect(microtime(true) - $started)->toBeLessThan(1.5);
    expect(Lane::run(laneStub(), "0\nnext", $o))->toBe('<svg>next</svg>');
});

it('1 running + 8 waiting: the 10th job is refused at once', function () {
    $o = laneOpts(3.0, 8);
    $held = [holdSlot($o, 'run.lock')];
    for ($i = 0; $i < 8; $i++) {
        $held[] = holdSlot($o, "wait-{$i}.lock");
    }
    $started = microtime(true);
    expect(laneRefusal(fn () => Lane::run(laneStub(), "0\nx", $o)))->toBe('too-complex');
    expect(microtime(true) - $started)->toBeLessThan(0.1);
    foreach ($held as $h) {
        fclose($h);
    }
});

it('the deadline counts the time spent waiting', function () {
    $o = laneOpts(0.3);
    $run = holdSlot($o, 'run.lock');
    $started = microtime(true);
    expect(laneRefusal(fn () => Lane::run(laneStub(), "0\nx", $o)))->toBe('too-complex');
    $elapsed = microtime(true) - $started;
    expect($elapsed)->toBeGreaterThan(0.25)->toBeLessThan(0.8);
    fclose($run);
});

it('the child start-up is not charged to the job', function () {
    putenv('LANE_STUB_STARTUP_MS=400');
    expect(Lane::run(laneStub(), "0\nslow-start", laneOpts(0.2)))->toBe('<svg>slow-start</svg>');
});

it('a waiting job of a client that went away leaves the queue and frees its waiting slot', function () {
    $o = laneOpts(3.0, 1);
    $run = holdSlot($o, 'run.lock');
    $polls = 0;
    $gone = function () use (&$polls): bool {
        return ++$polls > 3;
    };
    $started = microtime(true);
    expect(laneRefusal(fn () => Lane::run(laneStub(), "0\nx", $o, $gone)))->toBe('aborted');
    expect(microtime(true) - $started)->toBeLessThan(0.5);
    $wait = holdSlot($o, 'wait-0.lock'); // free again
    fclose($wait);
    fclose($run);
    expect(Lane::run(laneStub(), "0\nlegit", $o))->toBe('<svg>legit</svg>');
});

function laneFixture(string $name): string
{
    return base_path("tests/Fixtures/sandbox/{$name}.php");
}

/** Whether $pid is a live process (a zombie has ended: only its parent has not reaped it). */
function laneAlive(int $pid): bool
{
    $stat = @file_get_contents("/proc/{$pid}/stat");
    if ($stat === false) {
        return false;
    }
    $state = substr($stat, strrpos($stat, ')') + 2, 1);

    return $state !== 'Z' && $state !== 'X';
}

function laneWaitFor(callable $cond, float $sec): bool
{
    $until = microtime(true) + $sec;
    while (microtime(true) < $until) {
        if ($cond()) {
            return true;
        }
        usleep(20_000);
    }

    return $cond();
}

// Review I1 (Tasks 4+5): libxml2 allocates outside PHP's memory_limit, so the child's memory is bounded by the OS.
it('the child\'s memory is bounded by the OS, also what memory_limit does not count', function () {
    expect(Lane::run(laneFixture('hog'), (string) (8 << 20), laneOpts()))->toBe('allocated '.(8 << 20));
    $started = microtime(true);
    expect(laneRefusal(fn () => Lane::run(laneFixture('hog'), (string) (512 << 20), laneOpts())))->toBe('too-complex');
    expect(microtime(true) - $started)->toBeLessThan(1.0);
});

// Review M1: the child has its own wall-clock limit — it ends on its own after its budget (+1 s), even busy in C code.
it('a child left alone ends on its own alarm after its budget', function () {
    $proc = proc_open(Lane::command(laneFixture('spin'), laneOpts(), 1.0), [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
    expect(fgets($pipes[1]))->toBe("ready\n");
    $started = microtime(true);
    fclose($pipes[0]);
    $status = null;
    $ended = laneWaitFor(function () use ($proc, &$status) {
        $status = proc_get_status($proc);

        return ! $status['running'];
    }, 6.0);
    $elapsed = microtime(true) - $started;
    if (! $ended) {
        proc_terminate($proc, 9);
    }
    fclose($pipes[1]);
    proc_close($proc);
    expect($ended)->toBeTrue();
    expect($status['signaled'])->toBeTrue();
    expect($status['termsig'])->toBe(14); // SIGALRM
    expect($elapsed)->toBeGreaterThan(1.5)->toBeLessThan(2.0 + 0.5 * xlSlackLane()); // ceil(1 s) + 1 s after ready
});

// Review M1: a parent killed mid-job (a worker restart, a crash) takes its running child with it, at once.
it('a child dies when the parent that started it dies', function () {
    $dir = sys_get_temp_dir().'/agrotrace-lanes-test/orphan-'.getmypid().'-'.bin2hex(random_bytes(3));
    @mkdir($dir, 0777, true);
    $pidFile = "{$dir}/child.pid";
    $parent = proc_open(
        [PHP_BINARY, laneFixture('lane-parent'), laneFixture('spin'), $dir, '20', $pidFile],
        [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']],
        $pipes,
    );
    expect(laneWaitFor(fn () => is_file($pidFile) && (int) file_get_contents($pidFile) > 0, 20.0))->toBeTrue();
    $child = (int) file_get_contents($pidFile);
    expect(laneAlive($child))->toBeTrue(); // the job runs (its deadline is 20 s away)
    $killedAt = microtime(true);
    posix_kill(proc_get_status($parent)['pid'], SIGKILL);
    $gone = laneWaitFor(fn () => ! laneAlive($child), 3.0);
    $elapsed = microtime(true) - $killedAt;
    if (! $gone) {
        posix_kill($child, SIGKILL);
    }
    fclose($pipes[1]);
    proc_close($parent);
    expect($gone)->toBeTrue();
    expect($elapsed)->toBeLessThan(1.0);
});

function xlSlackLane(): float
{
    $s = getenv('TIMING_SLACK');

    return is_string($s) && is_numeric($s) ? (float) $s : 3.0;
}
