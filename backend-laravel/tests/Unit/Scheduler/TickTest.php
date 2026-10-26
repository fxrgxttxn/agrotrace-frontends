<?php

/*
 * The scheduler (L5, Review Focus 5; Express scheduler/runner.ts):
 * - SCHEDULER_TICK_MS → a Scheduler frequency (divisors of a minute, whole minutes dividing an hour), anything else a
 *   configuration error with exit 78 (Tick, agrotrace:job, agrotrace:preflight);
 * - a tick runs only under its session advisory lock: held by another session → skipped;
 * - real job processes (`agrotrace:job` over the real registry, tests/Fixtures/scheduler/job-child.php with stub job
 *   classes) on agrotrace_test_laravel: every job runs exactly once at start; a delivery tick sleeping 10 s does not
 *   delay the escalation ticks of another process by more than one tick; a held lock skips the ticks of a process
 *   until it is released; SIGTERM lets the running tick finish, then the process exits 0.
 */

use App\Infrastructure\Db\Tx;
use App\Scheduler\JobRun;
use App\Scheduler\Jobs\LabEscalation;
use App\Scheduler\LockLost;
use App\Scheduler\ScheduledJob;
use App\Scheduler\Tick;
use App\Scheduler\TickConfigError;
use App\Support\EnvConfig;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Database\Connection;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

it('maps SCHEDULER_TICK_MS onto Scheduler frequencies; the same set of values for the process timer', function () {
    expect(Tick::frequency(1000))->toBe('everySecond');
    expect(Tick::frequency(5000))->toBe('everyFiveSeconds');
    expect(Tick::frequency(300000))->toBe('everyFiveMinutes');
    expect(Tick::frequency(30000))->toBe('everyThirtySeconds');
    expect(Tick::frequency(60000))->toBe('everyMinute');
    expect(Tick::frequency(3600000))->toBe('hourly');
    expect(Tick::frequency(720000))->toBe('*/12 * * * *');
    $schedule = new Schedule;
    foreach ([1000, 2000, 5000, 10000, 15000, 20000, 30000, 60000, 120000, 180000, 240000, 300000, 360000, 600000,
        720000, 900000, 1200000, 1800000, 3600000] as $ms) {
        $event = Tick::apply($schedule->call(fn () => null)->name("t{$ms}"), $ms);
        expect(Tick::intervalOf($event))->toBe(Tick::intervalSec($ms))->toBe(intdiv($ms, 1000));
    }
});

it('refuses any other period as a configuration error (exit 78)', function (int $ms) {
    try {
        Tick::frequency($ms);
        $this->fail("{$ms} accepted");
    } catch (TickConfigError $e) {
        expect($e->getCode())->toBe(EnvConfig::EXIT_CONFIG);
    }
    expect(fn () => Tick::intervalSec($ms))->toThrow(TickConfigError::class);
    expect(implode("\n", EnvConfig::problems(['SCHEDULER_TICK_MS' => (string) $ms])))->toContain('SCHEDULER_TICK_MS');
})->with([500, 3000, 7000, 90000, 0, 420000, 7200000]);

it('accepts the stand\'s and the default period at preflight', function () {
    foreach (['1000', '300000', null] as $v) {
        expect(implode("\n", EnvConfig::problems(['SCHEDULER_TICK_MS' => $v])))->not->toContain('SCHEDULER_TICK_MS');
    }
});

/** A second session (another connection of the test DB). */
function otherSession(): Connection
{
    config(['database.connections.other' => config('database.connections.pgsql')]);

    return DB::connection('other');
}

it('skips the tick while another session holds the job\'s advisory lock', function () {
    $this->requireDatabase();
    $lock = 'agrotrace.scheduler.tick-test-'.bin2hex(random_bytes(3));
    $other = otherSession();
    $other->select('SELECT pg_advisory_lock(hashtext(?))', [$lock]);
    $runs = 0;
    try {
        expect(Tick::locked($lock, function () use (&$runs) {
            $runs++;
        }))->toBeFalse();
        expect($runs)->toBe(0);
    } finally {
        $other->select('SELECT pg_advisory_unlock(hashtext(?))', [$lock]);
        $other->disconnect();
    }
    expect(Tick::locked($lock, function () use (&$runs) {
        $runs++;
    }))->toBeTrue();
    expect($runs)->toBe(1);
    // Released in `finally`, also when the job throws.
    expect(fn () => Tick::locked($lock, fn () => throw new RuntimeException('boom')))->toThrow(RuntimeException::class);
    expect(DB::selectOne("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()")->n)->toBe(0);
});

it('a registry entry skips its tick while the lock is held elsewhere (JobRun → false)', function () {
    $this->requireDatabase();
    $runs = new ArrayObject;
    $this->app->bind(LabEscalation::class, fn () => new class($runs) implements ScheduledJob
    {
        public function __construct(private readonly ArrayObject $runs) {}

        public function run(): void
        {
            $this->runs->append(true);
        }
    });
    $other = otherSession();
    $other->select("SELECT pg_advisory_lock(hashtext('agrotrace.scheduler.lab-escalation'))");
    try {
        expect((new JobRun(LabEscalation::class, 'agrotrace.scheduler.lab-escalation'))())->toBeFalse();
        expect(count($runs))->toBe(0);
    } finally {
        $other->select("SELECT pg_advisory_unlock(hashtext('agrotrace.scheduler.lab-escalation'))");
        $other->disconnect();
    }
    expect((new JobRun(LabEscalation::class, 'agrotrace.scheduler.lab-escalation'))())->toBeTrue();
    expect(count($runs))->toBe(1);
});

/** Whether a fresh session can take $lock now (and gives it back at once). */
function lockIsFree(string $lock): bool
{
    $other = otherSession();
    try {
        $free = $other->selectOne('SELECT pg_try_advisory_lock(hashtext(?)) AS ok', [$lock])->ok === true;
        if ($free) {
            $other->select('SELECT pg_advisory_unlock(hashtext(?))', [$lock]);
        }

        return $free;
    } finally {
        $other->disconnect();
    }
}

it('a session killed mid-tick aborts the tick at its next statement — never a silent reconnect without the lock (T9 M4)', function () {
    $this->requireDatabase();
    $lock = 'agrotrace.scheduler.tick-test-'.bin2hex(random_bytes(3));
    $after = false;
    $thrown = null;
    try {
        Tick::locked($lock, function () use (&$after) {
            $pid = DB::selectOne('SELECT pg_backend_pid() AS pid')->pid;
            $other = otherSession();
            $other->select('SELECT pg_terminate_backend(?)', [$pid]);
            $other->disconnect();
            DB::select('SELECT 1'); // Laravel would reconnect here and go on
            $after = true;
        });
    } catch (Throwable $e) {
        $thrown = $e;
    }
    expect($thrown)->toBeInstanceOf(LockLost::class);
    expect($after)->toBeFalse();
    expect(lockIsFree($lock))->toBeTrue();
    // The guard is gone with the tick: the process's connection reconnects normally again.
    expect(DB::selectOne('SELECT 1 AS one')->one)->toBe(1);
});

it('a disconnect inside the tick is refused the same way; a transaction on the lost session fails, not retried elsewhere', function () {
    $this->requireDatabase();
    $lock = 'agrotrace.scheduler.tick-test-'.bin2hex(random_bytes(3));
    expect(fn () => Tick::locked($lock, function () {
        DB::disconnect();
        DB::select('SELECT 1');
    }))->toThrow(LockLost::class);
    expect(lockIsFree($lock))->toBeTrue();
    $writes = 0;
    expect(fn () => Tick::locked($lock, function () use (&$writes) {
        DB::disconnect();
        Tx::run(function () use (&$writes) {
            $writes++;
        });
    }))->toThrow(LockLost::class);
    expect($writes)->toBe(0);
    expect(DB::selectOne('SELECT 1 AS one')->one)->toBe(1);
});

it('a session lost after the tick\'s last statement, or a lock no longer held at the unlock, is reported (LockLost)', function () {
    $this->requireDatabase();
    $lock = 'agrotrace.scheduler.tick-test-'.bin2hex(random_bytes(3));
    expect(fn () => Tick::locked($lock, function () {
        $pid = DB::selectOne('SELECT pg_backend_pid() AS pid')->pid;
        $other = otherSession();
        $other->select('SELECT pg_terminate_backend(?)', [$pid]);
        $other->disconnect();
    }))->toThrow(LockLost::class);
    expect(lockIsFree($lock))->toBeTrue();
    expect(fn () => Tick::locked($lock, fn () => DB::select('SELECT pg_advisory_unlock(hashtext(?))', [$lock])))
        ->toThrow(LockLost::class, 'not held to the end');
    // The job's own error wins over the lock report.
    expect(fn () => Tick::locked($lock, function () {
        DB::disconnect();
        throw new RuntimeException('job failed');
    }))->toThrow(RuntimeException::class, 'job failed');
    expect(lockIsFree($lock))->toBeTrue();
    expect(DB::selectOne("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()")->n)->toBe(0);
});

/**
 * Starts `agrotrace:job <name>` (job-child.php) with SCHEDULER_TICK_MS = $tickMs and the stub sleeping $sleepMs.
 *
 * @return array{0: resource, 1: string} the process and its log file
 */
function jobChild(string $name, int $tickMs, int $sleepMs): array
{
    $log = sys_get_temp_dir().'/at-job-'.$name.'-'.bin2hex(random_bytes(4)).'.log';
    touch($log);
    $env = [...getenv(), 'SCHEDULER_TICK_MS' => (string) $tickMs];
    $proc = proc_open([PHP_BINARY, base_path('tests/Fixtures/scheduler/job-child.php'), $name, $log, (string) $sleepMs],
        [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, null, $env);

    return [$proc, $log];
}

/** @return list<array{0: string, 1: float}> [start|end, time] of the log */
function jobLog(string $log): array
{
    $out = [];
    foreach (file($log, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        [$what, , $at] = explode(' ', $line);
        $out[] = [$what, (float) $at];
    }

    return $out;
}

/** @return list<float> the start times */
function jobStarts(string $log): array
{
    return array_values(array_map(fn ($x) => $x[1], array_filter(jobLog($log), fn ($x) => $x[0] === 'start')));
}

/** Waits for $cond up to $sec seconds. */
function waitFor(callable $cond, float $sec): bool
{
    $deadline = microtime(true) + $sec;
    while (! $cond()) {
        if (microtime(true) > $deadline) {
            return false;
        }
        usleep(50_000);
    }

    return true;
}

/** The exit code once the process ends within $sec (proc_get_status reports it once), else -1 after a SIGKILL. */
function exitCode(mixed $proc, float $sec): int
{
    $deadline = microtime(true) + $sec;
    while (true) {
        $s = proc_get_status($proc);
        if (! $s['running']) {
            proc_close($proc);

            return $s['exitcode'];
        }
        if (microtime(true) > $deadline) {
            proc_terminate($proc, SIGKILL);
            proc_close($proc);

            return -1;
        }
        usleep(50_000);
    }
}

/** SIGTERM, then the exit code (-1 if it is still running after $sec). */
function stopChild(mixed $proc, float $sec = 10.0): int
{
    proc_terminate($proc, SIGTERM);

    return exitCode($proc, $sec);
}

it('each job process runs its job exactly once at start, then waits for its period', function () {
    $this->requireDatabase();
    $children = [];
    foreach (['lab-escalation', 'recall-task-overdue', 'notification-delivery', 'outbox-sweep'] as $name) {
        $children[$name] = jobChild($name, 60000, 0);
    }
    try {
        foreach ($children as $name => [, $log]) {
            expect(waitFor(fn () => count(jobStarts($log)) >= 1, 15.0))->toBeTrue("{$name} did not run at start");
        }
        usleep(1_500_000); // < the sweeper's 5 s and the others' 60 s
        foreach ($children as $name => [, $log]) {
            expect(count(jobStarts($log)))->toBe(1, $name);
        }
    } finally {
        foreach ($children as [$proc, $log]) {
            expect(stopChild($proc))->toBe(0);
            @unlink($log);
        }
    }
});

it('a delivery tick sleeping 10 s does not delay the escalation ticks of the other process by more than one tick', function () {
    $this->requireDatabase();
    [$delivery, $dlog] = jobChild('notification-delivery', 1000, 10_000);
    [$escalation, $elog] = jobChild('lab-escalation', 1000, 0);
    try {
        expect(waitFor(fn () => count(jobStarts($dlog)) === 1 && count(jobStarts($elog)) >= 1, 15.0))->toBeTrue();
        usleep(4_500_000);
        $starts = jobStarts($elog);
        expect(count($starts))->toBeGreaterThanOrEqual(4);
        for ($i = 1; $i < count($starts); $i++) {
            expect($starts[$i] - $starts[$i - 1])->toBeLessThan(2.0); // period 1 s: at most one tick late
        }
        // The delivery tick is still running: one start, no end.
        expect(array_column(jobLog($dlog), 0))->toBe(['start']);
    } finally {
        proc_terminate($delivery, SIGKILL);
        proc_close($delivery);
        expect(stopChild($escalation))->toBe(0);
        @unlink($dlog);
        @unlink($elog);
    }
});

it('a job process skips its ticks while another session holds the lock, and ticks once it is released', function () {
    $this->requireDatabase();
    $other = otherSession();
    $other->select("SELECT pg_advisory_lock(hashtext('agrotrace.scheduler.lab-escalation'))");
    [$proc, $log] = jobChild('lab-escalation', 1000, 0);
    try {
        usleep(3_000_000);
        expect(jobStarts($log))->toBe([]);
        $other->select("SELECT pg_advisory_unlock(hashtext('agrotrace.scheduler.lab-escalation'))");
        expect(waitFor(fn () => count(jobStarts($log)) >= 1, 3.0))->toBeTrue();
    } finally {
        $other->disconnect();
        expect(stopChild($proc))->toBe(0);
        @unlink($log);
    }
});

it('SIGTERM lets the running tick finish, then the process exits 0', function () {
    $this->requireDatabase();
    [$proc, $log] = jobChild('lab-escalation', 60000, 1500);
    try {
        expect(waitFor(fn () => count(jobStarts($log)) === 1, 15.0))->toBeTrue();
        $t0 = microtime(true);
        expect(stopChild($proc))->toBe(0);
        expect(microtime(true) - $t0)->toBeGreaterThan(0.5);
        expect(array_column(jobLog($log), 0))->toBe(['start', 'end']);
    } finally {
        @unlink($log);
    }
});

it('agrotrace:job refuses an invalid SCHEDULER_TICK_MS or an unknown job with exit 78', function (string $name, int $tickMs) {
    $this->requireDatabase();
    [$proc, $log] = jobChild($name, $tickMs, 0);
    expect(exitCode($proc, 15.0))->toBe(78);
    expect(jobStarts($log))->toBe([]);
    @unlink($log);
})->with([['lab-escalation', 7000], ['no-such-job', 1000]]);
