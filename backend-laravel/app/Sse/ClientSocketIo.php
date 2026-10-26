<?php

namespace App\Sse;

use App\Http\ClientConnection;
use Illuminate\Http\Request;

/**
 * StreamIo of api-laravel: the response goes client → (gateway) → HAProxy :8000 → FrankenPHP 127.0.0.1:8080 → this
 * PHP thread (docker/haproxy-api.cfg, docker/Caddyfile).
 *
 * - write: echo + flush(); FrankenPHP reports a client it knows to be gone on a write (connection_aborted(), with
 *   ignore_user_abort on).
 * - gone: HAProxy does not close its connection to FrankenPHP when the client leaves in the middle of a streamed
 *   response (measured: its client socket sits in CLOSE_WAIT, the server side stays ESTABLISHED, and nothing reaches
 *   PHP until a write). So the client's own socket is looked up: HAProxy passes the client's address and port in
 *   X-Agrotrace-Client-Peer (never taken from the client), and the client is gone once that socket of the container is
 *   not ESTABLISHED any more (ClientConnection::goneIn on /proc/net/tcp). One read of the table per second serves every
 *   stream of the process (APCu).
 * - backlog: what this host still holds for the client — FrankenPHP's send queue towards HAProxy, HAProxy's receive
 *   queue from FrankenPHP and HAProxy's send queue towards the client — read fresh from /proc/net/tcp. The kernel
 *   buffers on that path take several MiB (measured ~6.8 MiB before a write blocks), so the 1 MiB limit is reached
 *   long before the PHP thread could block on a client that does not read.
 * Without the header (tests, a direct call to FrankenPHP) gone() is false and backlog() unknown.
 */
final class ClientSocketIo implements StreamIo
{
    public const PEER_HEADER = 'X-Agrotrace-Client-Peer';

    private const TABLE_TTL_SEC = 1.0;

    private const CACHE_KEY = 'agrotrace:sse:proc-net-tcp';

    private ?string $clientPeer;

    private ?string $backendPeer;

    public function __construct(Request $request, private readonly string $procTcp = '/proc/net/tcp')
    {
        $this->backendPeer = ClientConnection::peer($request->server->get('REMOTE_ADDR'), $request->server->get('REMOTE_PORT'));
        $this->clientPeer = null;
        $h = $request->headers->get(self::PEER_HEADER);
        if (is_string($h) && preg_match('/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/D', $h, $m) === 1) {
            $this->clientPeer = ClientConnection::peer($m[1], $m[2]);
        }
    }

    public function write(string $bytes): bool
    {
        echo $bytes;
        flush();

        return connection_aborted() === 0;
    }

    public function gone(): bool
    {
        if ($this->clientPeer === null) {
            return false;
        }
        $table = $this->table(false);

        return $table !== null && ClientConnection::goneIn($table, $this->clientPeer);
    }

    public function backlog(): ?int
    {
        if ($this->clientPeer === null || $this->backendPeer === null) {
            return null;
        }
        $table = $this->table(true);
        if ($table === null) {
            return null;
        }

        return self::backlogIn($table, $this->backendPeer, $this->clientPeer);
    }

    /**
     * Bytes queued on the path in a /proc/net/tcp table: tx of the socket whose remote is $backendPeer (FrankenPHP's),
     * rx of the socket whose local is $backendPeer (HAProxy's server side), tx of the socket whose remote is
     * $clientPeer (HAProxy's client side).
     */
    public static function backlogIn(string $table, string $backendPeer, string $clientPeer): int
    {
        $sum = 0;
        foreach (explode("\n", $table) as $line) {
            $f = preg_split('/\s+/', trim($line));
            if ($f === false || count($f) < 5 || ! str_contains($f[4], ':')) {
                continue;
            }
            [$tx, $rx] = explode(':', $f[4], 2);
            if ($f[2] === $backendPeer || $f[2] === $clientPeer) {
                $sum += (int) hexdec($tx);
            } elseif ($f[1] === $backendPeer) {
                $sum += (int) hexdec($rx);
            }
        }

        return $sum;
    }

    private function table(bool $fresh): ?string
    {
        if (! $fresh && function_exists('apcu_fetch')) {
            $hit = @apcu_fetch(self::CACHE_KEY);
            if (is_array($hit) && microtime(true) - (float) $hit[0] < self::TABLE_TTL_SEC) {
                return (string) $hit[1];
            }
        }
        $table = @file_get_contents($this->procTcp);
        if (! is_string($table) || $table === '') {
            return null;
        }
        if (function_exists('apcu_store')) {
            @apcu_store(self::CACHE_KEY, [microtime(true), $table], 5);
        }

        return $table;
    }
}
