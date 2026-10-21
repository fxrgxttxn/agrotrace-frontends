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
 */
final class Lane
{
    private const POLL_US = 5_000;

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

    private static function execute(string $script, string $input, LaneOptions $o, float $deadline): string
    {
        $php = (string) config('agrotrace.sandbox.php', 'php');
        $proc = proc_open(
            [$php, '-d', "memory_limit={$o->memoryLimit}", '-d', 'display_errors=stderr', $script],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
        );
        if (! is_resource($proc)) {
            throw new LaneRefused('too-complex', 'the child did not start');
        }
        try {
            // Start-up is not charged: the clock pauses until `ready`.
            $startedAt = microtime(true);
            $ready = self::readLine($pipes[1], $startedAt + 30.0);
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
