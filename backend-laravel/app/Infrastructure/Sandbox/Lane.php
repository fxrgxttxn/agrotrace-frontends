<?php

namespace App\Infrastructure\Sandbox;

/**
 * Work off the request path (L6, P15/P18/P21/P24): a standalone PHP script (resources/sandbox/*.php, no Laravel) run by
 * `proc_open` per job, behind a container-wide bounded queue on flock slot files — the same bound for every Octane
 * worker thread of the container (each thread opens the files itself; flock holds per open file description):
 * - `run.lock` — the one running job; `wait-0 … wait-(N−1)` — the waiting ones. No free waiting slot → refused at once
 *   (`too-complex`).
 * - One deadline per job, counted from enqueue, waiting included; the child's start-up (until it writes `ready`) is not
 *   charged. A missed deadline kills the child (SIGKILL) — the next job gets a fresh one.
 * - A client that goes away ($clientGone) while its job waits leaves the queue (`aborted`); a running job is finished
 *   and its result discarded by the caller.
 * Protocol: the child writes `ready\n` once loaded, reads stdin to EOF, writes one result to stdout and exits 0.
 * The caller holds no DB slot meanwhile (P61).
 *
 * The child is bounded by the OS as well, never only by its parent (review I1/M1 of Tasks 4+5) — see `command()`:
 * - its private memory (RLIMIT_DATA: brk and anonymous mmap, so libxml2's allocations outside `memory_limit` count
 *   too) to the lane's memory plus CHILD_DATA_HEADROOM; past it an allocation fails and the job ends (too-complex or
 *   unsupported), whatever allocated;
 * - its life: SIGKILL when the thread that started it dies (PR_SET_PDEATHSIG, `setpriv`), and its own wall-clock
 *   alarm (resources/sandbox/limits.php: READY_SEC until `ready`, then the job's remaining budget + 1 s; SIGALRM's
 *   default action ends it even inside libxml2) plus RLIMIT_CPU as a last resort — so a child whose parent was killed
 *   or restarted mid-job cannot outlive the job's deadline and keep a CPU after its lane slot was handed on.
 */
final class Lane
{
    private const POLL_US = 5_000;

    /** The longest start-up (until `ready`) a child is given; it is not charged to the job's deadline. */
    public const READY_SEC = 30;

    /** The child's private memory beyond the lane's `memory_limit`: the engine's own data (~12 MiB) and slack. */
    public const CHILD_DATA_HEADROOM = 32 * 1024 * 1024;

    /** @param  null|callable(): bool  $clientGone */
    public static function run(string $script, string $input, LaneOptions $o, ?callable $clientGone = null): string
    {
        $dir = $o->dir();
        if (! is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $deadline = microtime(true) + $o->deadlineSec;
        $run = self::tryLock("{$dir}/run.lock");
        $wait = null;
        try {
            if ($run === null) {
                for ($i = 0; $i < $o->waiting && $wait === null; $i++) {
                    $wait = self::tryLock("{$dir}/wait-{$i}.lock");
                }
                if ($wait === null) {
                    throw new LaneRefused('too-complex', 'queue full');
                }
                while ($run === null) {
                    if ($clientGone !== null && $clientGone()) {
                        throw new LaneRefused('aborted', 'client gone while waiting');
                    }
                    if (microtime(true) >= $deadline) {
                        throw new LaneRefused('too-complex', 'deadline missed while waiting');
                    }
                    usleep(self::POLL_US);
                    $run = self::tryLock("{$dir}/run.lock");
                }
                self::unlock($wait);
                $wait = null;
            }

            return self::execute($script, $input, $o, $deadline);
        } finally {
            if ($wait !== null) {
                self::unlock($wait);
            }
            if ($run !== null) {
                self::unlock($run);
            }
        }
    }

    /**
     * The child's command line: `setpriv --pdeathsig KILL` and `prlimit` exec in place (the PID proc_open knows is the
     * PHP child's own, so proc_terminate reaches it), then PHP with the lane's memory_limit and the limits prelude.
     *
     * @return list<string>
     */
    public static function command(string $script, LaneOptions $o, float $budgetSec): array
    {
        $php = (string) config('agrotrace.sandbox.php', 'php');
        $budget = max(0.001, $budgetSec);
        $data = self::bytes($o->memoryLimit) + self::CHILD_DATA_HEADROOM;
        $cpu = self::READY_SEC + (int) ceil($budget) + 2;

        return [
            'setpriv', '--pdeathsig', 'KILL', '--',
            'prlimit', "--data={$data}", "--cpu={$cpu}", '--',
            $php, '-d', "memory_limit={$o->memoryLimit}", '-d', 'display_errors=stderr',
            '-d', 'auto_prepend_file='.dirname(__DIR__, 3).'/resources/sandbox/limits.php',
            '-d', 'agrotrace.sandbox_ready_sec='.self::READY_SEC,
            '-d', 'agrotrace.sandbox_budget_sec='.sprintf('%.3F', $budget),
            $script,
        ];
    }

    /** `256M` → bytes (PHP's shorthand: K, M, G). */
    private static function bytes(string $limit): int
    {
        $n = (int) $limit;

        return match (strtoupper(substr(trim($limit), -1))) {
            'G' => $n << 30,
            'M' => $n << 20,
            'K' => $n << 10,
            default => $n,
        };
    }

    private static function execute(string $script, string $input, LaneOptions $o, float $deadline): string
    {
        $proc = proc_open(
            self::command($script, $o, $deadline - microtime(true)),
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
        );
        if (! is_resource($proc)) {
            throw new LaneRefused('too-complex', 'the child did not start');
        }
        try {
            // Start-up is not charged: the clock pauses until `ready`.
            $startedAt = microtime(true);
            $ready = self::readLine($pipes[1], $startedAt + self::READY_SEC);
            if ($ready !== "ready\n") {
                throw new LaneRefused('too-complex', 'the child did not report ready');
            }
            $deadline += microtime(true) - $startedAt;
            stream_set_blocking($pipes[0], true);
            $written = 0;
            $len = strlen($input);
            while ($written < $len) {
                $n = @fwrite($pipes[0], substr($input, $written, 1 << 20));
                if ($n === false || $n === 0) {
                    throw new LaneRefused('too-complex', 'the child stopped reading');
                }
                $written += $n;
            }
            fclose($pipes[0]);
            unset($pipes[0]);
            $out = self::readAll($pipes[1], $deadline);
            if ($out === null) {
                proc_terminate($proc, 9);
                throw new LaneRefused('too-complex', 'deadline missed');
            }
            $status = proc_close($proc);
            $proc = null;
            if ($status !== 0) {
                throw new LaneRefused('too-complex', "the child exited with {$status}");
            }

            return $out;
        } finally {
            foreach ($pipes as $p) {
                if (is_resource($p)) {
                    fclose($p);
                }
            }
            if (is_resource($proc)) {
                proc_terminate($proc, 9);
                proc_close($proc);
            }
        }
    }

    /** @param  resource  $pipe */
    private static function readLine($pipe, float $until): ?string
    {
        stream_set_blocking($pipe, false);
        $line = '';
        while (! str_ends_with($line, "\n")) {
            $left = $until - microtime(true);
            if ($left <= 0) {
                return null;
            }
            $r = [$pipe];
            $w = $e = null;
            if (@stream_select($r, $w, $e, (int) $left, (int) (fmod($left, 1) * 1e6)) === false) {
                return null;
            }
            $c = fgets($pipe);
            if ($c === false) {
                if (feof($pipe)) {
                    return null;
                }

                continue;
            }
            $line .= $c;
        }

        return $line;
    }

    /**
     * Everything until EOF, or null when $until passes first.
     *
     * @param  resource  $pipe
     */
    private static function readAll($pipe, float $until): ?string
    {
        stream_set_blocking($pipe, false);
        $out = '';
        while (! feof($pipe)) {
            $left = $until - microtime(true);
            if ($left <= 0) {
                return null;
            }
            $r = [$pipe];
            $w = $e = null;
            if (@stream_select($r, $w, $e, (int) $left, (int) (fmod($left, 1) * 1e6)) === false) {
                return null;
            }
            $chunk = fread($pipe, 1 << 20);
            if ($chunk !== false) {
                $out .= $chunk;
            }
        }

        return $out;
    }

    /** @return resource|null */
    private static function tryLock(string $file)
    {
        $h = @fopen($file, 'c');
        if ($h === false) {
            return null;
        }
        if (flock($h, LOCK_EX | LOCK_NB)) {
            return $h;
        }
        fclose($h);

        return null;
    }

    /** @param  resource  $h */
    private static function unlock($h): void
    {
        flock($h, LOCK_UN);
        fclose($h);
    }
}
