<?php

namespace App\Infrastructure\Db;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Problem\Renderer;
use Illuminate\Database\Connection;
use Illuminate\Support\Facades\DB;
use LogicException;
use Throwable;

/**
 * Transactions (R47, R52, R54, Review Focus 1). Not DB::transaction($cb, $attempts): its retry heuristic and nested
 * savepoints are exactly what the contract forbids.
 * - The isolation level is the first command of the transaction (`SET TRANSACTION ISOLATION LEVEL …`).
 * - A deadlock (40P01) or serialization failure (40001) — SQLSTATE `errorInfo[0]` anywhere in the exception chain —
 *   or an error accepted by `retryIf` re-runs the WHOLE transaction once; a second failure is 409 VERSION_CONFLICT
 *   with `params` from `conflictParams` (read after the rollback).
 * - Nesting is refused: Tx::run inside a transaction is a programming error (LogicException).
 * - `$fn` may run twice, so it touches only the database (P8): effects that must follow the commit go to
 *   Tx::afterCommit (run after COMMIT, in order; dropped on rollback and on a retried attempt) or the outbox.
 * - Tx::now() is the transaction's `now()` as PostgreSQL prints it (microseconds kept) — the one instant every write
 *   of the operation uses (P43).
 */
final class Tx
{
    private const RETRYABLE = ['40001', '40P01'];

    public static function run(callable $fn, ?TxOptions $o = null): mixed
    {
        $o ??= new TxOptions;
        /** @var Connection $db */
        $db = DB::connection();
        $state = app(TxState::class);
        if ($state->active || $db->transactionLevel() !== 0) {
            throw new LogicException('Tx::run inside a transaction: nested transactions are not allowed');
        }
        for ($attempt = 1; ; $attempt++) {
            $state->begin();
            try {
                $db->beginTransaction();
                $db->statement('SET TRANSACTION ISOLATION LEVEL '.strtoupper($o->isolation)
                    .($o->readOnly ? ' READ ONLY' : ''));
                $result = $fn();
                $db->commit();
            } catch (Throwable $e) {
                $state->end();
                self::rollBackQuietly($db);
                if (! self::isRetryable($e) && ! ($o->retryIf !== null && ($o->retryIf)($e))) {
                    throw $e;
                }
                if ($attempt < 2) {
                    continue;
                }
                $params = $o->conflictParams !== null ? ($o->conflictParams)() : null;
                throw new Problem(409, ProblemCode::VERSION_CONFLICT, params: $params ?: null);
            }
            foreach ($state->end() as $effect) {
                $effect();
            }

            return $result;
        }
    }

    /** `now()` of the current attempt, e.g. `2026-10-21 12:34:56.123456+00` (one read per attempt). */
    public static function now(): string
    {
        $state = app(TxState::class);
        if (! $state->active) {
            throw new LogicException('Tx::now() outside Tx::run');
        }
        if ($state->now === null) {
            $row = DB::selectOne('SELECT now()::text AS now');
            $state->now = (string) $row->now;
        }

        return $state->now;
    }

    /** Runs $effect after the current attempt commits; dropped when it rolls back or is retried. */
    public static function afterCommit(callable $effect): void
    {
        $state = app(TxState::class);
        if (! $state->active) {
            throw new LogicException('Tx::afterCommit() outside Tx::run');
        }
        $state->effects[] = $effect;
    }

    public static function active(): bool
    {
        return app(TxState::class)->active;
    }

    /** 40001 / 40P01 anywhere in the exception chain. */
    public static function isRetryable(Throwable $e): bool
    {
        for ($x = $e; $x !== null; $x = $x->getPrevious()) {
            if (in_array(Renderer::sqlState($x), self::RETRYABLE, true)) {
                return true;
            }
        }

        return false;
    }

    private static function rollBackQuietly(Connection $db): void
    {
        try {
            if ($db->transactionLevel() > 0) {
                $db->rollBack(0);
            }
        } catch (Throwable) {
            // The connection is gone: Laravel resets its transaction counter on reconnect.
        }
    }
}
