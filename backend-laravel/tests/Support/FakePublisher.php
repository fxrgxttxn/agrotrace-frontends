<?php

namespace Tests\Support;

use App\Infrastructure\Amqp\BrokerUnavailable;
use App\Infrastructure\Amqp\ConfirmPublisher;

/**
 * A fake broker for the relay and the sweeper: every send is appended (flock'ed) to a log file shared by the test and
 * its child processes as `<who> <messageId> <routingKey> <body sha1>`, then the "confirm" takes `$confirmMs`; with
 * `$fail` the confirm is negative (BrokerUnavailable), as a nack or a confirm timeout is.
 */
final class FakePublisher implements ConfirmPublisher
{
    public function __construct(
        private readonly string $log,
        private readonly string $who,
        private readonly int $confirmMs = 0,
        private readonly bool $fail = false,
    ) {}

    public function publishAll(array $messages, float $timeoutSec = 10.0): void
    {
        $h = fopen($this->log, 'a');
        flock($h, LOCK_EX);
        foreach ($messages as $m) {
            fwrite($h, "{$this->who} {$m['messageId']} {$m['routingKey']} ".sha1($m['body'])."\n");
        }
        flock($h, LOCK_UN);
        fclose($h);
        usleep($this->confirmMs * 1000);
        if ($this->fail) {
            throw new BrokerUnavailable('fake broker: negative confirm');
        }
    }

    public function isOpen(): bool
    {
        return true;
    }

    /** @return list<array{who: string, id: string, routingKey: string, sha: string}> */
    public static function sends(string $log): array
    {
        if (! is_file($log)) {
            return [];
        }
        $out = [];
        foreach (file($log, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            [$who, $id, $rk, $sha] = explode(' ', $line);
            $out[] = ['who' => $who, 'id' => $id, 'routingKey' => $rk, 'sha' => $sha];
        }

        return $out;
    }
}
