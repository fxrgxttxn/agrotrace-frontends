<?php

namespace App\Console\Commands;

use App\Http\Query\QueryReader;
use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Db\DbSlots;
use App\Infrastructure\Outbox\Relay;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Socket;
use Throwable;

/**
 * `artisan agrotrace:relay` — the api container's relay process (supervisord, next to FrankenPHP; L4 placement in
 * the Task 6 report): it receives the ids of committed outbox events from the Octane workers (RelayNotifier, Unix
 * datagrams on `agrotrace.relay.socket`) and publishes them (Relay: confirm channel opened first, rows locked across
 * the confirm). Requests never wait on the broker; the process holds at most ONE PostgreSQL connection, taken from
 * the container's DbSlots (DB_SLOTS budget, P61) only while it publishes and given back as soon as nothing is
 * pending. While the broker is down the ids stay pending (at most MAX_PENDING) and are retried after Broker's
 * back-off; the outbox sweeper covers anything dropped.
 */
final class RelayDaemon extends Command
{
    public const MAX_PENDING = 10000;

    public const PER_PUBLISH = 500;

    protected $signature = 'agrotrace:relay';

    protected $description = 'Publish the outbox events the API committed (after the response, off the request path)';

    public function handle(): int
    {
        $path = (string) config('agrotrace.relay.socket', '/tmp/agrotrace-relay.sock');
        $sock = $this->bind($path);
        $relay = Relay::fromConfig('agrotrace-laravel-relay');
        $stop = false;
        pcntl_async_signals(true);
        foreach ([SIGTERM, SIGINT] as $sig) {
            pcntl_signal($sig, function () use (&$stop) {
                $stop = true;
            });
        }
        Log::info('relay listening', ['socket' => $path]);
        /** @var array<string, true> $pending */
        $pending = [];
        $retryAt = 0.0;
        $failing = false;
        while (! $stop) {
            $wait = $pending === [] ? 1.0 : max(0.0, $retryAt - microtime(true));
            $read = [$sock];
            $none = null;
            if (@socket_select($read, $none, $none, (int) $wait, (int) (fmod($wait, 1.0) * 1_000_000)) > 0) {
                $this->drain($sock, $pending);
            }
            if ($pending === [] || microtime(true) < $retryAt) {
                continue;
            }
            try {
                foreach (array_chunk(array_keys($pending), self::PER_PUBLISH) as $chunk) {
                    $relay->publish(array_map('strval', $chunk));
                    foreach ($chunk as $id) {
                        unset($pending[$id]);
                    }
                }
                $failing = false;
            } catch (BrokerUnavailable $e) {
                if (! $failing) {
                    Log::warning('relay: the broker is unavailable; the ids stay pending', ['pending' => count($pending), 'err' => $e->getMessage()]);
                }
                $failing = true;
                $retryAt = microtime(true) + 0.5;
            } catch (Throwable $e) {
                Log::warning('relay failed; retrying', ['pending' => count($pending), 'err' => $e->getMessage()]);
                $retryAt = microtime(true) + 1.0;
            }
            if ($pending === [] || $retryAt > microtime(true)) {
                // Nothing left, or waiting out a failure: give the connection and the DbSlots slot back (P61 holder
                // rule) — an outage never parks an idle connection.
                DB::disconnect();
                app(DbSlots::class)->release();
            }
        }
        socket_close($sock);
        @unlink($path);

        return self::SUCCESS;
    }

    private function bind(string $path): Socket
    {
        $sock = socket_create(AF_UNIX, SOCK_DGRAM, 0);
        if (! $sock instanceof Socket) {
            throw new RuntimeException('relay: cannot create the socket');
        }
        @unlink($path);
        if (! socket_bind($sock, $path)) {
            throw new RuntimeException("relay: cannot bind {$path}: ".socket_strerror(socket_last_error($sock)));
        }
        @chmod($path, 0666);
        socket_set_nonblock($sock);

        return $sock;
    }

    /** @param  array<string, true>  $pending */
    private function drain(Socket $sock, array &$pending): void
    {
        $buf = '';
        $from = '';
        while (($n = @socket_recvfrom($sock, $buf, 65536, 0, $from)) !== false && $n > 0) {
            foreach (explode("\n", $buf) as $id) {
                if (! QueryReader::isUuid($id)) {
                    continue;
                }
                if (count($pending) < self::MAX_PENDING) {
                    $pending[$id] = true;
                } else {
                    Log::warning('relay: too many pending ids; dropping (the sweeper publishes)', ['eventId' => $id]);
                }
            }
        }
    }
}
