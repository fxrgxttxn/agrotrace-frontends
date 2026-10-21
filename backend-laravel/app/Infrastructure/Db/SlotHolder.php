<?php

namespace App\Infrastructure\Db;

use Illuminate\Support\Facades\DB;
use LogicException;

/**
 * P61 holder discipline: a request holds its DbSlots slot and PostgreSQL connection only around its SQL. Before
 * CPU-heavy or remote work (Argon2, image decoding, the SVG sandbox, S3, DaData, SMTP) it gives both back with
 * `release()`; the next query reconnects lazily (Laravel reconnects a missing PDO; PgConnector takes a slot again,
 * ≤ 5 s, else 503). Never inside a transaction.
 */
final class SlotHolder
{
    public static function release(): void
    {
        if (Tx::active()) {
            throw new LogicException('SlotHolder::release() inside a transaction');
        }
        DB::disconnect();
        app(DbSlots::class)->release();
    }

    /** Runs $work (heavy or remote) with no slot or connection held. */
    public static function without(callable $work): mixed
    {
        self::release();

        return $work();
    }
}
