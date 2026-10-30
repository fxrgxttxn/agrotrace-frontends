<?php

namespace App\Infrastructure\Outbox;

use Illuminate\Support\Facades\Log;
use Socket;

/**
 * The request side of the relay (L4 «relay после ответа», placed as the Task 6 report justifies): after the response,
 * EndOfRequest hands the ids of the outbox events the request committed to the api container's relay process
 * (`artisan agrotrace:relay`, RelayLoop) as Unix datagrams on `agrotrace.relay.socket` — a non-blocking `sendto`,
 * microseconds, no broker, no DB slot, no waiting.
 *
 * If the hand-off fails (the relay is not bound — restarting, stopping, not up yet — or its queue is full, EAGAIN), the
 * ids are not lost: the rows are committed, and the sender touches the marker file `agrotrace.relay.dropped`. The
 * relay sees the marker and catches up from the outbox itself (RelayLoop: the oldest unpublished rows of handled
 * types), as it also does at start and periodically. The outbox sweeper (Task 9) remains the last line.
 */
final class RelayNotifier
{
    /** Ids per datagram (37 bytes each: far below the Unix datagram limit). */
    public const PER_DATAGRAM = 200;

    /** @param  list<string>  $eventIds */
    public static function send(array $eventIds, ?string $socketPath = null, ?string $droppedMarker = null): bool
    {
        if ($eventIds === []) {
            return true;
        }
        $path = $socketPath ?? self::socketPath();
        $marker = $droppedMarker ?? self::droppedMarker();
        $sock = @socket_create(AF_UNIX, SOCK_DGRAM, 0);
        if (! $sock instanceof Socket) {
            self::dropped($marker, $eventIds, 'no socket');

            return false;
        }
        try {
            socket_set_nonblock($sock);
            foreach (array_chunk($eventIds, self::PER_DATAGRAM) as $i => $chunk) {
                $msg = implode("\n", $chunk);
                if (@socket_sendto($sock, $msg, strlen($msg), 0, $path) !== strlen($msg)) {
                    self::dropped($marker, array_slice($eventIds, $i * self::PER_DATAGRAM), socket_strerror(socket_last_error($sock)));

                    return false;
                }
            }

            return true;
        } finally {
            socket_close($sock);
        }
    }

    public static function socketPath(): string
    {
        return (string) config('agrotrace.relay.socket', '/tmp/agrotrace-relay.sock');
    }

    public static function droppedMarker(): string
    {
        return (string) config('agrotrace.relay.dropped_marker', '/tmp/agrotrace-relay.dropped');
    }

    /** @param  list<string>  $eventIds */
    private static function dropped(string $marker, array $eventIds, string $err): void
    {
        @touch($marker);
        Log::warning('relay hand-off failed; the relay catches the ids up from the outbox', ['eventIds' => $eventIds, 'err' => $err]);
    }
}
