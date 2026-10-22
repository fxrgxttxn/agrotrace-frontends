<?php

namespace App\Http;

use Illuminate\Http\Request;

/**
 * Whether the client of the current request went away, before any byte of the response is written (P18: a waiting
 * SVG job of an aborted upload leaves the lane).
 *
 * FrankenPHP 1.4 reports a disconnect to PHP only from a write or a flush (go_ub_write / go_sapi_flush check the
 * request context): connection_aborted() stays 0 while nothing is written, and flush() commits a 200 with the headers
 * so far — neither is usable before the response is known (fix round 1, I2: measured in a probe container). What is
 * observable is the TCP connection itself: the request reaches FrankenPHP (127.0.0.1:8080) from the HAProxy front, and
 * HAProxy, with `option abortonclose` (docker/haproxy-api.cfg), closes that connection as soon as the client closes
 * its own — the gateway's nginx does the same towards HAProxy (proxy_ignore_client_abort off). So the client is gone
 * when no socket of the peer address (REMOTE_ADDR:REMOTE_PORT, either end) is ESTABLISHED in /proc/net/tcp any more.
 * Unknown (no peer port, IPv6, no /proc) → never gone: the lane's deadline still bounds the job.
 */
final class ClientConnection
{
    /**
     * At most one /proc/net/tcp read per this many seconds per request (the lane polls every 5 ms). A read costs ~4 ms
     * in api-laravel (measured: the kernel builds the table on every read), so 9 waiting jobs at 150 ms cost ~0.25 of a
     * core instead of ~0.7 at 50 ms, while an aborted job still leaves the queue well within its deadline (review N2).
     */
    private const CHECK_EVERY_SEC = 0.15;

    private const ESTABLISHED = '01';

    /** @return callable(): bool */
    public static function watcher(Request $request, string $procTcp = '/proc/net/tcp'): callable
    {
        $peer = self::peer($request->server->get('REMOTE_ADDR'), $request->server->get('REMOTE_PORT'));
        $lastCheck = 0.0;
        $gone = false;

        return function () use ($peer, $procTcp, &$lastCheck, &$gone): bool {
            if ($gone || $peer === null) {
                return $gone;
            }
            $now = microtime(true);
            if ($now - $lastCheck < self::CHECK_EVERY_SEC) {
                return false;
            }
            $lastCheck = $now;
            $table = @file_get_contents($procTcp);
            if (is_string($table) && $table !== '') {
                $gone = self::goneIn($table, $peer);
            }

            return $gone;
        };
    }

    /** `0100007F:DFC0` (the /proc/net/tcp form: IPv4 bytes little-endian, port big-endian, upper-case hex), or null. */
    public static function peer(mixed $addr, mixed $port): ?string
    {
        if (! is_string($addr) || ! is_scalar($port) || ! ctype_digit((string) $port)) {
            return null;
        }
        $p = (int) $port;
        $packed = @inet_pton($addr);
        if ($packed === false || strlen($packed) !== 4 || $p < 1 || $p > 65535) {
            return null;
        }

        return strtoupper(bin2hex(strrev($packed))).':'.sprintf('%04X', $p);
    }

    /** Whether no line of the table has $peer as its local or remote address in state ESTABLISHED. */
    public static function goneIn(string $table, string $peer): bool
    {
        $at = 0;
        $needle = ' '.$peer.' ';
        while (($p = strpos($table, $needle, $at)) !== false) {
            $lineStart = $p === 0 ? false : strrpos($table, "\n", $p - strlen($table) - 1);
            $lineStart = $lineStart === false ? 0 : $lineStart + 1;
            $lineEnd = strpos($table, "\n", $p);
            $line = substr($table, $lineStart, ($lineEnd === false ? strlen($table) : $lineEnd) - $lineStart);
            // `  sl  local_address rem_address   st …`
            $fields = array_values(array_filter(explode(' ', $line), fn (string $f) => $f !== ''));
            if (($fields[1] ?? '') === $peer || ($fields[2] ?? '') === $peer) {
                if (($fields[3] ?? '') === self::ESTABLISHED) {
                    return false;
                }
            }
            $at = $lineEnd === false ? strlen($table) : $lineEnd;
        }

        return true;
    }
}
