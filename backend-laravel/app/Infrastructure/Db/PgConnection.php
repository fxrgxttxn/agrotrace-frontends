<?php

namespace App\Infrastructure\Db;

use Closure;
use Illuminate\Database\PostgresConnection;
use Illuminate\Database\QueryException;

/**
 * The pgsql connection with one change (final review M2): a failed statement's QueryException carries its SQL with
 * the `?` placeholders, never the bound values. Laravel interpolates the bindings into the message, and the message is
 * logged (the exception handler's record message, `err` fields) — a statement timeout on `UPDATE users SET
 * totp_secret = ?` would log a live TOTP secret, other statements Argon2 hashes or emails. Express's pg errors carry no
 * parameters either. The exception class (UniqueConstraintViolationException included), SQLSTATE and errorInfo stay.
 */
final class PgConnection extends PostgresConnection
{
    /**
     * @param  string  $query
     * @param  array<mixed>  $bindings
     */
    protected function runQueryCallback($query, $bindings, Closure $callback)
    {
        try {
            return parent::runQueryCallback($query, $bindings, $callback);
        } catch (QueryException $e) {
            throw self::withoutBindings($e);
        }
    }

    public static function withoutBindings(QueryException $e): QueryException
    {
        $class = $e::class;

        return new $class($e->getConnectionName(), $e->getSql(), array_fill(0, count($e->getBindings()), '?'), $e->getPrevious() ?? $e);
    }
}
