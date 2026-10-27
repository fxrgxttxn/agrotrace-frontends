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
    /** The longest start-up (until `ready`) a child is given; it is not charged to the job's deadline. */
    public const READY_SEC = 30;

    /** The child's private memory beyond the lane's `memory_limit`: the engine's own data (~12 MiB) and slack. */
    public const CHILD_DATA_HEADROOM = 32 * 1024 * 1024;

    /** @param  null|callable(): bool  $clientGone */
    public static function run(string $script, string $input, LaneOptions $o, ?callable $clientGone = null): string
    {
        $ticket = self::admit($o);
        try {
            return $ticket->run($script, $input, $clientGone);
        } finally {
            $ticket->release();
        }
    }

    /**
     * Enqueues a job before its input exists: the ticket holds the running slot when it is free, else a waiting one,
     * and the job's deadline starts now — so a caller takes its place before preparing the input (downloadReport:
     * admission before any data is read, P52). No free place → `too-complex` at once. The ticket is released by
     * LaneTicket::release (or its destruction).
     */
    public static function admit(LaneOptions $o): LaneTicket
    {
        $dir = $o->dir();
        if (! is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $deadline = microtime(true) + $o->deadlineSec;
        $run = self::tryLock("{$dir}/run.lock");
        $wait = null;
        if ($run === null) {
            for ($i = 0; $i < $o->waiting && $wait === null; $i++) {
                $wait = self::tryLock("{$dir}/wait-{$i}.lock");
            }
            if ($wait === null) {
                throw new LaneRefused('too-complex', 'queue full');
            }
        }

        return new LaneTicket($o, $deadline, $run, $wait);
    }

    /**
     * The child's command line: `setpriv --pdeathsig KILL` and `prlimit` exec in place (the PID proc_open knows is the
     * PHP child's own, so proc_terminate reaches it), then PHP with the lane's memory_limit and the limits prelude.
     *
     * @return list<string>
     */
    public static function command(string $script, LaneOptions $o, float $budgetSec, ?string $tmpDir = null): array
    {
        $tmp = $tmpDir !== null ? ['-d', "sys_temp_dir={$tmpDir}"] : [];
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
            ...$tmp,
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

    /**
     * Writes $data to the child's stdin (non-blocking) by $deadline — a child that stops reading cannot hold the
     * caller past the job's deadline. False when the child closed its stdin (it ended early: its stdout decides).
     *
     * @param  resource  $pipe
     */
    private static function writeAll($pipe, string $data, float $deadline): bool
    {
        $len = strlen($data);
        for ($written = 0; $written < $len;) {
            $left = $deadline - microtime(true);
            if ($left <= 0) {
                throw new LaneRefused('too-complex', 'deadline missed while writing the input');
            }
            $r = $e = null;
            $w = [$pipe];
            $ready = @stream_select($r, $w, $e, (int) $left, (int) (fmod($left, 1) * 1e6));
            if ($ready === false) {
                return false;
            }
            if ($ready === 0) {
                continue; // not writable yet: the deadline check above decides
            }
            $n = @fwrite($pipe, substr($data, $written, 1 << 16));
            if ($n === false) {
                return false;
            }
            $written += $n;
        }

        return true;
    }

    /**
     * Runs one job in a fresh child, the running slot already held (LaneTicket). $input — the child's stdin: a string,
     * or parts written in order (strings, and streams copied to their end). The child gets a temporary directory of
     * its own (`sys_temp_dir`), removed here whatever ends the child — a child killed on its deadline leaves no files.
     *
     * @param  string|list<string|resource>  $input
     */
    public static function execute(string $script, string|array $input, LaneOptions $o, float $deadline): string
    {
        $tmp = $o->dir().'/job-'.bin2hex(random_bytes(8));
        if (! @mkdir($tmp, 0700, true)) {
            throw new LaneRefused('too-complex', 'no temporary directory for the child');
        }
        try {
            return self::executeIn($tmp, $script, $input, $o, $deadline);
        } finally {
            self::removeTree($tmp);
        }
    }

    private static function removeTree(string $dir): void
    {
        foreach (glob("{$dir}/{,.}*", GLOB_BRACE) ?: [] as $f) {
            $base = basename($f);
            if ($base === '.' || $base === '..') {
                continue;
            }
            is_dir($f) && ! is_link($f) ? self::removeTree($f) : @unlink($f);
        }
        @rmdir($dir);
    }

    /** @param  string|list<string|resource>  $input */
    private static function executeIn(string $tmp, string $script, string|array $input, LaneOptions $o, float $deadline): string
    {
        $proc = proc_open(
            self::command($script, $o, $deadline - microtime(true), $tmp),
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
            stream_set_blocking($pipes[0], false);
            foreach (is_array($input) ? $input : [$input] as $part) {
                if (is_string($part)) {
                    if (! self::writeAll($pipes[0], $part, $deadline)) {
                        break;
                    }

                    continue;
                }
                while (! feof($part)) {
                    $chunk = fread($part, 1 << 20);
                    if ($chunk === false) {
                        throw new LaneRefused('too-complex', 'the job input could not be read');
                    }
                    if (! self::writeAll($pipes[0], $chunk, $deadline)) {
                        break 2;
                    }
                }
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

    /**
     * A slot file flock'ed without waiting (LaneTicket too).
     *
     * @return resource|null
     */
    public static function tryLock(string $file)
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
    public static function unlock($h): void
    {
        flock($h, LOCK_UN);
        fclose($h);
    }
}
