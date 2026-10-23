<?php

namespace App\Infrastructure\Qr;

use App\Infrastructure\Db\BackendUnavailable;
use App\Infrastructure\Db\DbSlots;
use App\Infrastructure\Db\Tx;
use LogicException;

/**
 * The bounded lane of QR rendering (createBatchQr: the 1024² PNG and the A6 PDF label, ~0.1 s of CPU per request):
 * at most `agrotrace.qr.render_slots` renders run at once per container, at most WAITING requests wait for one, a wait
 * ends after DEADLINE_SEC — a flood of QR generations can neither take every CPU nor every Octane worker. Slot and
 * waiting files are flock'ed (as DbSlots and the sandbox lanes: every FrankenPHP thread opens them itself, the kernel
 * drops a dead holder's lock). A full queue or a missed deadline is 503 BACKEND_UNAVAILABLE (BackendUnavailable), the
 * answer of every other exhausted bound. Taken with no DB slot or connection held (P61).
 */
final class RenderLane
{
    public const WAITING = 8;

    public const DEADLINE_SEC = 10.0;

    /**
     * @template T
     *
     * @param  callable(): T  $work
     * @return T
     */
    public static function with(callable $work, ?string $dir = null, ?int $slots = null, float $deadlineSec = self::DEADLINE_SEC): mixed
    {
        if (Tx::active() || app(DbSlots::class)->held()) {
            throw new LogicException('RenderLane::with() with a DB slot held');
        }
        $slots ??= max(1, (int) config('agrotrace.qr.render_slots', 2));
        $dir ??= (string) config('agrotrace.qr.render_dir', '/tmp/agrotrace-qr-render');
        if (! is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $deadline = microtime(true) + $deadlineSec;
        $run = self::tryAny($dir, 'slot', $slots);
        $wait = null;
        try {
            if ($run === null) {
                $wait = self::tryAny($dir, 'wait', self::WAITING);
                if ($wait === null) {
                    throw new BackendUnavailable('QR render lane: '.self::WAITING.' requests already waiting');
                }
                while ($run === null) {
                    if (microtime(true) >= $deadline) {
                        throw new BackendUnavailable("QR render lane: no slot within {$deadlineSec} s");
                    }
                    usleep(random_int(2_000, 10_000));
                    $run = self::tryAny($dir, 'slot', $slots);
                }
                self::unlock($wait);
                $wait = null;
            }

            return $work();
        } finally {
            if ($wait !== null) {
                self::unlock($wait);
            }
            if ($run !== null) {
                self::unlock($run);
            }
        }
    }

    /** @return resource|null */
    private static function tryAny(string $dir, string $prefix, int $count)
    {
        $start = random_int(0, $count - 1);
        for ($k = 0; $k < $count; $k++) {
            $h = @fopen("{$dir}/{$prefix}-".(($start + $k) % $count), 'c');
            if ($h === false) {
                throw new LogicException("RenderLane: cannot open {$dir}/{$prefix}");
            }
            if (flock($h, LOCK_EX | LOCK_NB)) {
                return $h;
            }
            fclose($h);
        }

        return null;
    }

    /** @param  resource  $h */
    private static function unlock($h): void
    {
        flock($h, LOCK_UN);
        fclose($h);
    }
}
