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
