<?php

namespace App\Infrastructure\Images;

use App\Infrastructure\Db\BackendUnavailable;

/**
 * A container-wide bound on concurrent raster decoding (review M1 of Tasks 2+3): `IMAGE_DECODE_SLOTS` flock'ed files,
 * as DbSlots. Unbounded, a flood of uploads ran GD in every Octane worker thread at once and starved the CPU for
 * everything else; Express gets the same bound from libvips' thread pool. Every worker thread opens the slot file
 * itself (flock holds per open file description), the kernel drops a lock whose process died. Waiting is bounded by
 * the worker count in practice; the 60 s cap only guards against a wedged holder.
 */
final class DecodeSlots
{
    private const WAIT_SEC = 60.0;

    /**
     * @template T
     *
     * @param  callable(): T  $work
     * @return T
     */
    public static function with(callable $work): mixed
    {
        $count = max(1, (int) config('agrotrace.images.decode_slots', 2));
        $dir = (string) config('agrotrace.images.decode_slots_dir', '/tmp/agrotrace-decode-slots');
        if (! is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $handle = self::acquire($count, $dir);
        try {
            return $work();
        } finally {
            if ($handle !== null) {
                flock($handle, LOCK_UN);
                fclose($handle);
            }
        }
    }

    /** @return resource|null null: the slot files cannot be opened (no bound rather than no upload) */
    private static function acquire(int $count, string $dir)
    {
        $deadline = microtime(true) + self::WAIT_SEC;
        $start = random_int(0, $count - 1);
        $opened = false;
        do {
            for ($k = 0; $k < $count; $k++) {
                $h = @fopen($dir.'/slot-'.(($start + $k) % $count), 'c');
                if ($h === false) {
                    continue;
                }
                $opened = true;
                if (flock($h, LOCK_EX | LOCK_NB)) {
                    return $h;
                }
                fclose($h);
            }
            if (! $opened) {
                return null;
            }
            usleep(random_int(2_000, 8_000));
        } while (microtime(true) < $deadline);

        throw new BackendUnavailable("no image decode slot of {$count} became free within ".self::WAIT_SEC.' s');
    }
}
