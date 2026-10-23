<?php

namespace App\Infrastructure\Outbox;

use App\Events\EventHandlers;
use App\Infrastructure\Amqp\Broker;
use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Amqp\ConfirmPublisher;
use App\Infrastructure\Amqp\Publisher;
use App\Infrastructure\Db\Tx;
use App\Support\Json;
use Closure;
use LogicException;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Outbox publishing (R55, R56, envelope; Express infra/relay.ts `publishLocked`): rows of `outbox_events`
 * (backend laravel) go to the exchange `agrotrace.laravel` with routing key = `type` (persistent, application/json,
 * message_id = id, the body = the envelope) on a confirm channel, then
 * `UPDATE … SET published_at = now(), attempts = attempts + 1 WHERE id = :id AND published_at IS NULL`.
 *
 * - The confirm channel is opened BEFORE the transaction: a broker that is down or reconnecting never holds a DB
 *   connection, row locks or the sweeper's advisory lock (Broker fails fast and backs off).
 * - The rows are picked `FOR NO KEY UPDATE SKIP LOCKED` and stay locked across the publish AND the broker's confirm,
 *   up to the UPDATE and COMMIT: a relay and a sweeper (or two relays) never send the same row twice; a row in flight
 *   is simply skipped by the other side. A failed or timed-out confirm (10 s) rolls the transaction back — the rows
 *   are unlocked and unpublished, retried later; a process killed mid-confirm loses its session, PostgreSQL releases
 *   the locks the same way. A second send happens only after such a failure (at-least-once; consumers claim ids).
 * - Only types with a registered handler (EventHandlers) are picked: others stay in the outbox until their handler
 *   lands — dead-lettering them would lose them (Django Ruling Q12).
 */
final class Relay
{
    public const EXCHANGE = 'agrotrace.laravel';

    public const SWEEP_BATCH = 100;

    private ?ConfirmPublisher $publisher = null;

    /** @param  null|Closure(): ConfirmPublisher  $open  opens a confirm channel (default: a Publisher on the Broker; Pest: a fake broker) */
    public function __construct(
        private readonly Broker $broker,
        private readonly float $confirmTimeoutSec = 10.0,
        private readonly ?Closure $open = null,
    ) {}

    public static function fromConfig(string $name): self
    {
        return new self(Broker::fromConfig($name), (float) config('agrotrace.amqp.confirm_timeout_sec', 10.0));
    }

    /**
     * Publishes these rows now (after their transaction committed). Ids already published, locked by someone else or
     * of an unhandled type are skipped. Returns the number published.
     *
     * @param  list<string>  $eventIds
     *
     * @throws BrokerUnavailable the broker is down (nothing published; the rows wait)
     */
    public function publish(array $eventIds): int
    {
        $eventIds = array_values(array_unique($eventIds));
        if ($eventIds === []) {
            return 0;
        }
        $marks = implode(',', array_fill(0, count($eventIds), '?'));

        return $this->publishLocked("id IN ({$marks})", $eventIds, count($eventIds));
    }

    /** One sweeper batch: the oldest SWEEP_BATCH unpublished rows of handled types. @throws BrokerUnavailable */
    public function publishOldest(int $limit = self::SWEEP_BATCH): int
    {
        return $this->publishLocked('true', [], $limit);
    }

    /** The confirm channel (opened now if needed). @throws BrokerUnavailable */
    public function publisher(): ConfirmPublisher
    {
        if ($this->publisher !== null && $this->publisher->isOpen()) {
            return $this->publisher;
        }
        $this->publisher = null;
        try {
            $this->publisher = $this->open !== null ? ($this->open)() : new Publisher($this->broker->channel());
        } catch (BrokerUnavailable $e) {
            throw $e;
        } catch (Throwable $e) {
            $this->broker->reset();
            $this->broker->failed();
            throw new BrokerUnavailable('rabbitmq: '.$e->getMessage(), 0, $e);
        }

        return $this->publisher;
    }

    /** Closes the channel and the connection (after a failed or timed-out confirm: a fresh one next time). */
    public function reset(): void
    {
        $this->publisher = null;
        $this->broker->reset();
    }

    /**
     * The pick, the publish + confirm and the UPDATE run in ONE transaction of their own. This is deliberately not
     * Tx::run: Tx re-runs its closure on 40001/40P01 (P8: the closure touches only the database), and a broker publish
     * is a side effect a retry must never repeat. Here any failure rolls back and is thrown, never retried; the caller
     * (relay process, worker, sweeper) decides when to try again. The isolation level is pinned to READ COMMITTED:
     * SKIP LOCKED plus the UPDATE's `published_at IS NULL` re-check are what rule out a second send.
     *
     * @param  list<mixed>  $bindings
     */
    private function publishLocked(string $pick, array $bindings, int $limit): int
    {
        if (Tx::active() || DB::transactionLevel() !== 0) {
            throw new LogicException('Relay inside a transaction: publish only after the events\' transaction committed');
        }
        $publisher = $this->publisher();
        $types = EventHandlers::types();
        $typeMarks = implode(',', array_fill(0, count($types), '?'));
        $db = DB::connection();
        try {
            $db->beginTransaction();
            try {
                $db->statement('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
                $rows = $db->select("SELECT id, type, payload::text AS payload FROM outbox_events
                     WHERE backend = 'laravel' AND published_at IS NULL AND type IN ({$typeMarks}) AND {$pick}
                     ORDER BY created_at LIMIT ? FOR NO KEY UPDATE SKIP LOCKED", [...$types, ...$bindings, $limit]);
                if ($rows === []) {
                    $db->commit();

                    return 0;
                }
                // The row locks stay held across the publish AND the confirm: a sweeper or another relay skips them.
                $publisher->publishAll(array_map(fn ($r) => [
                    'exchange' => self::EXCHANGE,
                    'routingKey' => $r->type,
                    // The envelope as compact JSON (jsonb's text form has spaces), as Express sends it.
                    'body' => Json::encode(Json::decode($r->payload)),
                    'messageId' => $r->id,
                    'mandatory' => false,
                ], $rows), $this->confirmTimeoutSec);
                $ids = array_map(fn ($r) => $r->id, $rows);
                $db->update('UPDATE outbox_events SET published_at = now(), attempts = attempts + 1
                     WHERE id IN ('.implode(',', array_fill(0, count($ids), '?')).') AND published_at IS NULL', $ids);
                $db->commit();

                return count($rows);
            } catch (Throwable $e) {
                try {
                    if ($db->transactionLevel() > 0) {
                        $db->rollBack(0);
                    }
                } catch (Throwable) {
                    // The connection is gone: PostgreSQL ended the session and released the row locks.
                }
                throw $e;
            }
        } catch (BrokerUnavailable $e) {
            $this->reset();
            throw $e;
        }
    }
}
