<?php

/*
 * batch_documents.last_error (final review M4): a transport failure of Mercury is stored as Express stores it —
 * `mercury: fetch failed` / `mercury: timeout after N ms`, never cURL's text with the URL and its query.
 */

use App\Infrastructure\Mercury\Mercury;
use Tests\TestCase;

uses(TestCase::class);

function mercuryQuery(): array
{
    return ['productCode' => 'P-1', 'senderInn' => '7700000000', 'dateFrom' => '2026-01-01', 'dateTo' => '2026-01-31'];
}

it('a refused connection is "mercury: fetch failed"', function () {
    expect((new Mercury('http://127.0.0.1:1', 1000))->listVsd(mercuryQuery()))
        ->toBe(['ok' => false, 'error' => 'mercury: fetch failed']);
});

it('a timeout is "mercury: timeout after N ms"', function () {
    expect((new Mercury('http://10.255.255.1:81', 300))->listVsd(mercuryQuery()))
        ->toBe(['ok' => false, 'error' => 'mercury: timeout after 300 ms']);
});
