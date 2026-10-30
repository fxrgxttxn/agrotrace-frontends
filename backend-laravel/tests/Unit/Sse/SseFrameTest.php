<?php

/*
 * The SSE events byte for byte as Express writes them (sse/hub.ts; contracts/openapi/paths/events.yaml): `id:` only on
 * `notification` (= seq), `data:` one line of JSON (newlines inside strings escaped), a blank line after every event,
 * `ts` of `ping` without milliseconds.
 */

use App\Sse\SseFrame;
use Tests\TestCase;

uses(TestCase::class);

it('writes notification with id = seq and the Notification as one JSON line', function () {
    $n = [
        'id' => 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e', 'seq' => 1042, 'type' => 'COMPLAINT',
        'payload' => (object) ['productName' => "Молоко\nи «сливки» / 2", 'complaintId' => 'c'],
        'isRead' => false, 'createdAt' => '2026-09-24T09:00:12.000Z',
    ];
    $frame = SseFrame::notification($n);
    expect($frame)->toBe("id: 1042\nevent: notification\ndata: "
        .'{"id":"b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e","seq":1042,"type":"COMPLAINT","payload":{"productName":"Молоко\\nи «сливки» / 2","complaintId":"c"},"isRead":false,"createdAt":"2026-09-24T09:00:12.000Z"}'
        ."\n\n");
    expect(substr_count($frame, "\n"))->toBe(4);
    $n['payload'] = new stdClass;
    expect(SseFrame::notification($n))->toContain('"payload":{}');
});

it('writes unread, ping (seconds only) and reauth', function () {
    expect(SseFrame::unread(3))->toBe("event: unread\ndata: {\"count\":3}\n\n");
    expect(SseFrame::unread(0))->toBe("event: unread\ndata: {\"count\":0}\n\n");
    expect(SseFrame::ping(new DateTimeImmutable('2026-09-24T09:00:37.987654Z')))->toBe("event: ping\ndata: {\"ts\":\"2026-09-24T09:00:37Z\"}\n\n");
    expect(SseFrame::ping(new DateTimeImmutable('2026-09-24T12:00:37+03:00')))->toBe("event: ping\ndata: {\"ts\":\"2026-09-24T09:00:37Z\"}\n\n");
    expect(SseFrame::ping())->toMatch('/^event: ping\ndata: \{"ts":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"\}\n\n$/');
    expect(SseFrame::reauth())->toBe("event: reauth\ndata: {\"reason\":\"TOKEN_EXPIRED\"}\n\n");
});
