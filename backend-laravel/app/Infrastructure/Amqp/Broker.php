<?php

namespace App\Infrastructure\Amqp;

use PhpAmqpLib\Channel\AMQPChannel;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use Throwable;

/**
 * One lazy RabbitMQ connection per process (R55 topology from infra/rabbitmq/definitions.json — nothing is declared
 * here), failing fast: a short connect + handshake timeout (`connectTimeoutSec`, 2 s), channel RPCs bounded by the
 * same, and after a failure a back-off (0.5, 1, 2 … 10 s, as Express infra/amqp.ts) during which `connection()` throws
 * at once without touching the network — an outage costs one bounded attempt per back-off step, never a wait per
 * call. Heartbeats are off (a consumer runs its handlers synchronously and could not answer them); the socket keeps
 * TCP keepalive; a dropped connection is noticed by the next read or write, which resets it.
 */
final class Broker
{
    private ?AMQPStreamConnection $conn = null;

    private int $failures = 0;

    private float $retryAt = 0.0;

    public function __construct(
        private readonly string $url,
        private readonly string $name,
        private readonly float $connectTimeoutSec = 2.0,
        private readonly float $readWriteTimeoutSec = 10.0,
    ) {}

    public static function fromConfig(string $name): self
    {
        return new self(
            (string) config('agrotrace.rabbitmq_url'),
            $name,
            (float) config('agrotrace.amqp.connect_timeout_sec', 2.0),
            (float) config('agrotrace.amqp.read_write_timeout_sec', 10.0),
        );
    }

    /** @throws BrokerUnavailable */
    public function connection(): AMQPStreamConnection
    {
        if ($this->conn !== null && $this->conn->isConnected()) {
            return $this->conn;
        }
        $this->conn = null;
        if (microtime(true) < $this->retryAt) {
            throw new BrokerUnavailable('rabbitmq: in back-off after a failed connection');
        }
        $u = parse_url($this->url) ?: [];
        $path = isset($u['path']) ? substr($u['path'], 1) : '';
        $vhost = $path === '' ? '/' : rawurldecode($path);
        try {
            $this->conn = new AMQPStreamConnection(
                $u['host'] ?? 'localhost',
                $u['port'] ?? 5672,
                rawurldecode($u['user'] ?? 'guest'),
                rawurldecode($u['pass'] ?? 'guest'),
                $vhost,
                false,
                'AMQPLAIN',
                null,
                'en_US',
                $this->connectTimeoutSec,
                $this->readWriteTimeoutSec,
                null,
                true,
                0,
                $this->connectTimeoutSec,
            );
            $this->failures = 0;
            $this->retryAt = 0.0;

            return $this->conn;
        } catch (Throwable $e) {
            $this->conn = null;
            $this->failed();
            throw new BrokerUnavailable('rabbitmq: '.$e->getMessage(), 0, $e);
        }
    }

    /** A new channel on the connection. @throws BrokerUnavailable */
    public function channel(): AMQPChannel
    {
        $conn = $this->connection();
        try {
            return $conn->channel();
        } catch (Throwable $e) {
            $this->reset();
            $this->failed();
            throw new BrokerUnavailable('rabbitmq: '.$e->getMessage(), 0, $e);
        }
    }

    /** Drops the connection (after an error on it), closing it quietly. */
    public function reset(): void
    {
        $conn = $this->conn;
        $this->conn = null;
        if ($conn !== null) {
            try {
                $conn->close();
            } catch (Throwable) {
                // Already gone.
            }
        }
    }

    /** Counts a failure: the next attempt waits min(0.5 · 2^k, 10) s. */
    public function failed(): void
    {
        $this->retryAt = microtime(true) + min(0.5 * 2 ** $this->failures, 10.0);
        $this->failures++;
    }

    /** Seconds until the next connection attempt (0 — now). */
    public function backoffLeft(): float
    {
        return max(0.0, $this->retryAt - microtime(true));
    }

    public function name(): string
    {
        return $this->name;
    }
}
