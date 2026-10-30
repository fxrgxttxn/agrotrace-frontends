<?php

/*
 * The Mercury adapter and the VSD choice (vsd.import.schema.json; Express infra/mercury.ts): the query, the test-stand
 * header (P35), every failure kind, the Mercury format (nested objects stripped, the document passed through), and
 * the pick — among CONFIRMED the greatest issueDate, then number, then uuid by code points.
 */

use App\Infrastructure\Mercury\Mercury;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

uses(TestCase::class);

function vsdItem(array $over = []): array
{
    return [
        'uuid' => '3f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0', 'number' => 'VSD-2026-000012', 'issueDate' => '2026-09-01',
        'status' => 'CONFIRMED', 'product' => ['code' => '10.11.11', 'name' => 'Говядина', 'extra' => 1],
        'volume' => ['value' => 2400, 'unit' => 'кг'], 'consignor' => ['inn' => '502701234075', 'name' => 'КФХ Петров'],
        'consignee' => ['inn' => '7701234567', 'name' => 'ООО Мясо'], 'vetInspection' => ['result' => 'OK'], ...$over,
    ];
}

const VSD_QUERY = ['productCode' => '10.11.11', 'senderInn' => '502701234075', 'dateFrom' => '2026-08-29', 'dateTo' => '2026-09-04'];

it('queries GET /api/v1/vsd with the four parameters and passes the document through, nested objects stripped', function () {
    Http::fake(['*' => Http::response(['items' => [vsdItem()]])]);
    $r = (new Mercury('http://mercury:8080'))->listVsd(VSD_QUERY);
    Http::assertSent(fn (Request $req) => $req->url() === 'http://mercury:8080/api/v1/vsd?productCode=10.11.11&senderInn=502701234075&dateFrom=2026-08-29&dateTo=2026-09-04'
        && ! $req->hasHeader('X-Mock-Fail'));
    expect($r['ok'])->toBeTrue();
    $doc = $r['items'][0];
    expect((array) $doc->product)->toBe(['code' => '10.11.11', 'name' => 'Говядина']);
    expect($doc->vetInspection->result)->toBe('OK');
});

it('adds X-Mock-Fail for the test-stand product codes (P35)', function () {
    Http::fake(['*' => Http::response('', 500)]);
    $r = (new Mercury('http://m', 10000, ['99.99.99'], '500'))->listVsd([...VSD_QUERY, 'productCode' => '99.99.99']);
    Http::assertSent(fn (Request $req) => $req->header('X-Mock-Fail') === ['500']);
    expect($r)->toBe(['ok' => false, 'error' => 'mercury: HTTP 500']);
});

it('fails on a body that is not the Mercury format', function (mixed $body, string $error) {
    Http::fake(['*' => Http::response($body)]);
    expect((new Mercury('http://m'))->listVsd(VSD_QUERY))->toBe(['ok' => false, 'error' => $error]);
})->with([
    'not a list' => [['data' => []], 'mercury: the response is not a VSD list'],
    'bad uuid' => [['items' => [vsdItem(['uuid' => 'x'])]], 'mercury: a VSD item does not match the Mercury format'],
    'bad status' => [['items' => [vsdItem(['status' => 'DRAFT'])]], 'mercury: a VSD item does not match the Mercury format'],
    'bad inn' => [['items' => [vsdItem(['consignor' => ['inn' => '123', 'name' => 'x']])]], 'mercury: a VSD item does not match the Mercury format'],
    'negative volume' => [['items' => [vsdItem(['volume' => ['value' => -1, 'unit' => 'кг']])]], 'mercury: a VSD item does not match the Mercury format'],
    'long number' => [['items' => [vsdItem(['number' => str_repeat('9', 65)])]], 'mercury: a VSD item does not match the Mercury format'],
]);

it('a connection failure or timeout is a failed call, never an exception', function () {
    Http::fake(fn () => throw new ConnectionException('cURL error 28: Operation timed out'));
    expect((new Mercury('http://m', 10000))->listVsd(VSD_QUERY))->toBe(['ok' => false, 'error' => 'mercury: timeout after 10000 ms']);
});

it('picks the latest CONFIRMED: greatest issueDate, then number, then uuid (code points); none → null', function () {
    $mk = fn (array $o) => Mercury::vsd(json_decode(json_encode(vsdItem($o))));
    $a = $mk(['issueDate' => '2026-09-01', 'number' => 'B', 'uuid' => '00000000-0000-4000-8000-000000000001']);
    $b = $mk(['issueDate' => '2026-09-02', 'number' => 'A', 'uuid' => '00000000-0000-4000-8000-000000000002']);
    $c = $mk(['issueDate' => '2026-09-02', 'number' => 'B', 'uuid' => '00000000-0000-4000-8000-000000000003']);
    $d = $mk(['issueDate' => '2026-09-02', 'number' => 'B', 'uuid' => '00000000-0000-4000-8000-000000000004']);
    $w = $mk(['issueDate' => '2026-12-31', 'status' => 'WITHDRAWN']);
    expect(Mercury::pick([$a, $b, $c, $d, $w]))->toBe($d);
    expect(Mercury::pick([$d, $c, $b, $a]))->toBe($d);
    expect(Mercury::pick([$a, $b]))->toBe($b);
    $lower = $mk(['number' => 'Z']);
    $cyr = $mk(['number' => 'Я']);
    expect(Mercury::pick([$cyr, $lower]))->toBe($cyr); // U+042F > U+005A
    expect(Mercury::pick([$w]))->toBeNull();
    expect(Mercury::pick([]))->toBeNull();
});
