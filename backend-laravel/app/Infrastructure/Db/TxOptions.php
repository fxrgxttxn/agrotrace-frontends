<?php

namespace App\Infrastructure\Db;

use Closure;
use InvalidArgumentException;

/**
 * Options of Tx::run (R47/R52/R54): the isolation level (READ COMMITTED by default, REPEATABLE READ for the recall
 * engine), READ ONLY, the `params` of the final 409 (`conflictParams`, e.g. fn () => ['currentVersion' => …], read
 * after the failed attempts) and extra errors that re-run the transaction once (`retryIf`, e.g. the engine's
 * `23505 ux_recalls_open_source`).
 */
final class TxOptions
{
    public const ISOLATIONS = ['read committed', 'repeatable read', 'serializable'];

    public function __construct(
        public readonly string $isolation = 'read committed',
        public readonly bool $readOnly = false,
        public readonly ?Closure $conflictParams = null,
        public readonly ?Closure $retryIf = null,
    ) {
        if (! in_array($isolation, self::ISOLATIONS, true)) {
            throw new InvalidArgumentException("unsupported isolation level {$isolation}");
        }
    }
}
