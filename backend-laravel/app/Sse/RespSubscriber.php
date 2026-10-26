<?php

namespace App\Sse;

/**
 * A minimal Redis pub/sub client for one SSE stream (L3): its own TCP connection, RESP2 parsed incrementally from what
 * arrived (a frame may come in any number of pieces), every wait a stream_select with a timeout — never phpredis'
 * blocking subscribe(), which would hold the PHP thread until a message.
 *
 * - subscribe($channels, $getKeys): one write — `GET` of each key, then `SUBSCRIBE` — so the values are read just
 *   before the subscription starts (the stream's generation, N1); returns them once every channel is confirmed;
 * - next($timeoutSec): the next `message` as [channel, payload], or null when nothing came within the timeout;
 * - liveness: a `PING` every 30 s of the subscription (allowed in subscribed mode); no `pong` within 10 s, a closed
 *   socket or an error reply is a lost subscription (RespError) — the stream then reconnects and catches up.
 */
final class RespSubscriber implements Subscription
{
    public const PING_EVERY_SEC = 30.0;

    public const PONG_TIMEOUT_SEC = 10.0;

    /** @var resource|null */
    private $socket = null;

    private string $buffer = '';

    private float $lastPing = 0.0;

    private ?float $pingSent = null;

    /** @var list<array{0: string, 1: string}> messages that arrived while waiting for the confirmations */
    private array $queued = [];

    public function __construct(
        private readonly string $host,
        private readonly int $port,
        private readonly ?string $username = null,
        private readonly ?string $password = null,
        private readonly float $connectTimeoutSec = 2.0,
        private readonly float $pingEverySec = self::PING_EVERY_SEC,
        private readonly float $pongTimeoutSec = self::PONG_TIMEOUT_SEC,
    ) {}

    /** The default Redis connection (REDIS_URL, config/database.php). */
    public static function fromConfig(): self
    {
        $url = (string) config('database.redis.default.url', 'redis://redis:6379/0');
        $p = parse_url($url) ?: [];
        $user = isset($p['user']) && $p['user'] !== '' ? rawurldecode($p['user']) : null;
        $pass = isset($p['pass']) ? rawurldecode($p['pass']) : null;

        return new self((string) ($p['host'] ?? 'redis'), (int) ($p['port'] ?? 6379), $user, $pass,
            (float) config('database.redis.default.timeout', 2.0));
    }

    /**
     * Connects and subscribes.
     *
     * @param  list<string>  $channels
     * @param  list<string>  $getKeys
     * @return array<string, ?string> the values of $getKeys, read right before the subscription
     *
     * @throws RespError
     */
    public function subscribe(array $channels, array $getKeys = []): array
    {
        $this->close();
        $errno = 0;
        $errstr = '';
        $s = @stream_socket_client("tcp://{$this->host}:{$this->port}", $errno, $errstr, $this->connectTimeoutSec);
        if ($s === false) {
            throw new RespError("redis connect failed: {$errstr}");
        }
        stream_set_blocking($s, true);
        stream_set_timeout($s, (int) ceil($this->connectTimeoutSec));
        if (function_exists('socket_import_stream')) {
            $sock = @socket_import_stream($s);
            if ($sock !== false) {
                @socket_set_option($sock, SOL_SOCKET, SO_KEEPALIVE, 1);
            }
        }
        $this->socket = $s;
        $this->buffer = '';
        $this->queued = [];
        $out = '';
        if ($this->password !== null) {
            $out .= self::command($this->username !== null ? ['AUTH', $this->username, $this->password] : ['AUTH', $this->password]);
        }
        foreach ($getKeys as $k) {
            $out .= self::command(['GET', $k]);
        }
        $out .= self::command(['SUBSCRIBE', ...$channels]);
        $this->send($out);
        $deadline = microtime(true) + $this->connectTimeoutSec;
        if ($this->password !== null) {
            $this->reply($deadline);
        }
        $values = [];
        foreach ($getKeys as $k) {
            $v = $this->reply($deadline);
            $values[$k] = is_string($v) ? $v : null;
        }
        $confirmed = 0;
        while ($confirmed < count($channels)) {
            $r = $this->reply($deadline);
            if (is_array($r) && ($r[0] ?? null) === 'subscribe') {
                $confirmed++;
            } elseif (is_array($r) && ($r[0] ?? null) === 'message' && count($r) === 3) {
                $this->queued[] = [(string) $r[1], (string) $r[2]];
            }
        }
        $this->lastPing = microtime(true);
        $this->pingSent = null;

        return $values;
    }

    /**
     * The next message, or null after $timeoutSec without one.
     *
     * @return null|array{0: string, 1: string} [channel, payload]
     *
     * @throws RespError
     */
    public function next(float $timeoutSec): ?array
    {
        if ($this->queued !== []) {
            return array_shift($this->queued);
        }
        if ($this->socket === null) {
            throw new RespError('not subscribed');
        }
        $deadline = microtime(true) + max(0.0, $timeoutSec);
        $polled = false;
        while (true) {
            while (($r = $this->parse()) !== RespParser::INCOMPLETE) {
                if (is_array($r) && ($r[0] ?? null) === 'message' && count($r) === 3) {
                    return [(string) $r[1], (string) $r[2]];
                }
                if (is_array($r) && ($r[0] ?? null) === 'pong') {
                    $this->pingSent = null;
                }
                // else: a late confirmation — nothing to do
            }
            $now = microtime(true);
            if ($this->pingSent !== null && $now - $this->pingSent >= $this->pongTimeoutSec) {
                $this->close();
                throw new RespError('redis subscription: no pong within '.$this->pongTimeoutSec.' s');
            }
            if ($this->pingSent === null && $now - $this->lastPing >= $this->pingEverySec) {
                $this->send(self::command(['PING']));
                $this->pingSent = $now;
                $this->lastPing = $now;
            }
            if ($now >= $deadline && $polled) {
                return null;
            }
            $keep = $this->pingSent !== null ? $this->pingSent + $this->pongTimeoutSec : $this->lastPing + $this->pingEverySec;
            $this->fill(max(0.0, min($deadline, $keep) - $now));
            $polled = true;
        }
    }

    public function close(): void
    {
        if ($this->socket !== null) {
            @fclose($this->socket);
        }
        $this->socket = null;
        $this->buffer = '';
    }

    public function connected(): bool
    {
        return $this->socket !== null;
    }

    /** @param  list<string>  $args */
    public static function command(array $args): string
    {
        $out = '*'.count($args)."\r\n";
        foreach ($args as $a) {
            $out .= '$'.strlen($a)."\r\n".$a."\r\n";
        }

        return $out;
    }

    /** One complete reply (the subscription handshake), waiting until $deadline. */
    private function reply(float $deadline): mixed
    {
        while (($r = $this->parse()) === RespParser::INCOMPLETE) {
            $left = $deadline - microtime(true);
            if ($left <= 0) {
                $this->close();
                throw new RespError('redis subscription: no reply in time');
            }
            $this->fill($left);
        }
        if ($r instanceof RespError) {
            $this->close();
            throw $r;
        }

        return $r;
    }

    private function parse(): mixed
    {
        $pos = 0;
        $r = RespParser::parse($this->buffer, $pos);
        if ($r !== RespParser::INCOMPLETE) {
            $this->buffer = substr($this->buffer, $pos);
            if ($r instanceof RespError) {
                $this->close();
                throw $r;
            }
        }

        return $r;
    }

    /** Reads what arrives within $sec (nothing is fine); a closed socket is a lost subscription. */
    private function fill(float $sec): void
    {
        if ($this->socket === null) {
            throw new RespError('not subscribed');
        }
        $read = [$this->socket];
        $none = null;
        $n = @stream_select($read, $none, $none, (int) $sec, (int) (($sec - (int) $sec) * 1_000_000));
        if ($n === false) {
            $this->close();
            throw new RespError('redis subscription: select failed');
        }
        if ($n === 0) {
            return;
        }
        $chunk = @fread($this->socket, 65536);
        if ($chunk === false || ($chunk === '' && feof($this->socket))) {
            $this->close();
            throw new RespError('redis subscription: connection closed');
        }
        $this->buffer .= $chunk;
    }

    private function send(string $bytes): void
    {
        if ($this->socket === null) {
            throw new RespError('not subscribed');
        }
        $len = strlen($bytes);
        for ($done = 0; $done < $len;) {
            $n = @fwrite($this->socket, substr($bytes, $done));
            if ($n === false || $n === 0) {
                $this->close();
                throw new RespError('redis subscription: write failed');
            }
            $done += $n;
        }
    }
}
