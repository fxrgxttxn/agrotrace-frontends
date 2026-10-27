<?php

namespace App\Sse;

use App\Support\Json;
use DateTimeImmutable;
use DateTimeZone;

/**
 * The events of GET /events/stream (contracts/openapi/paths/events.yaml), byte for byte as Express writes them
 * (sse/hub.ts): `id:` only on `notification` (= seq), `data:` one line of JSON (the app's JSON.stringify), a blank line
 * after each event.
 */
final class SseFrame
{
    /** @param  array{id: string, seq: int, type: string, payload: mixed, isRead: bool, createdAt: string}  $n */
    public static function notification(array $n): string
    {
        return "id: {$n['seq']}\nevent: notification\ndata: ".Json::encode($n)."\n\n";
    }

    public static function unread(int $count): string
    {
        return "event: unread\ndata: ".Json::encode(['count' => $count])."\n\n";
    }

    /** `ts` — the instant without milliseconds (Express isoSec). */
    public static function ping(?DateTimeImmutable $now = null): string
    {
        $now ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));

        return "event: ping\ndata: ".Json::encode(['ts' => $now->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z')])."\n\n";
    }

    public static function reauth(): string
    {
        return "event: reauth\ndata: ".Json::encode(['reason' => 'TOKEN_EXPIRED'])."\n\n";
    }

    /** The whole answer to a stream past the cap (StreamAdmission): the EventSource reconnects after $ms. */
    public static function retry(int $ms): string
    {
        return "retry: {$ms}\n\n";
    }
}
