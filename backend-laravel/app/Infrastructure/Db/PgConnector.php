<?php

namespace App\Infrastructure\Db;

use Illuminate\Database\Connectors\PostgresConnector;
use PDO;
use Throwable;

/**
 * The pgsql connector of every process (bound as `db.connector.pgsql`, AppServiceProvider). L4/P61 order: a DbSlots
 * slot first (≤ 5 s, else 503), then the connection (connect_timeout 5 s: PDO::ATTR_TIMEOUT in config/database.php,
 * application_name `agrotrace-laravel-<process>`), then the session: statement_timeout 30 s, lock_timeout 10 s,
 * TimeZone UTC. A failed connection gives the slot back.
 */
final class PgConnector extends PostgresConnector
{
    public function __construct(private readonly DbSlots $slots) {}

    /** @param  array<string, mixed>  $config */
    public function connect(array $config): PDO
    {
        $this->slots->acquire((float) config('agrotrace.db.slot_timeout', 5.0));
        try {
            $pdo = parent::connect($config);
            $pdo->exec(sprintf(
                "SET statement_timeout = '%s'; SET lock_timeout = '%s'; SET TIME ZONE 'UTC'",
                config('agrotrace.db.statement_timeout', '30s'),
                config('agrotrace.db.lock_timeout', '10s'),
            ));

            return $pdo;
        } catch (Throwable $e) {
            $this->slots->release();
            throw $e;
        }
    }
}
