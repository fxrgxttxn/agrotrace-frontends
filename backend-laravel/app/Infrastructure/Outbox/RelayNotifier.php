<?php

namespace App\Infrastructure\Outbox;

use Illuminate\Support\Facades\Log;
use Socket;

/**
 * The request side of the relay (L4 «relay после ответа», placed as the Task 6 report justifies): after the response,
 * EndOfRequest hands the ids of the outbox events the request committed to the api container's relay process
 * (`artisan agrotrace:relay`) as Unix datagrams on `agrotrace.relay.socket` — a non-blocking `sendto`, microseconds,
 * no broker, no DB slot, no waiting. The relay process publishes them (Relay: confirm, row lock held across it). If
 * the process is not there or its socket buffer is full the ids are dropped with a warning: the rows are committed
 * and the outbox sweeper (scheduler, every 5 s) publishes them — this path is the fast one, the sweeper the guarantee.
 */
final class RelayNotifier
{
    /** Ids per datagram (37 bytes each: far below the Unix datagram limit). */
    public const PER_DATAGRAM = 200;

    /** @param  list<string>  $eventIds */
    public static function send(array $eventIds, ?string $socketPath = null): bool
    {
        if ($eventIds === []) {
            return true;
        }
        $path = $socketPath ?? (string) config('agrotrace.relay.socket', '/tmp/agrotrace-relay.sock');
        $sock = @socket_create(AF_UNIX, SOCK_DGRAM, 0);
        if (! $sock instanceof Socket) {
            Log::warning('relay notify: no socket; the sweeper publishes', ['eventIds' => $eventIds]);

            return false;
        }
        try {
            socket_set_nonblock($sock);
            foreach (array_chunk($eventIds, self::PER_DATAGRAM) as $chunk) {
                $msg = implode("\n", $chunk);
                if (@socket_sendto($sock, $msg, strlen($msg), 0, $path) !== strlen($msg)) {
                    Log::warning('relay notify failed; the sweeper publishes', ['eventIds' => $chunk,
                        'err' => socket_strerror(socket_last_error($sock))]);

                    return false;
                }
            }

            return true;
        } finally {
            socket_close($sock);
        }
    }
}
