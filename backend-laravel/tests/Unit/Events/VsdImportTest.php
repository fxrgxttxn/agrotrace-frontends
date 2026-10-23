<?php

/*
 * The vsd.import handler directly (review M4; contracts/events/vsd.import.schema.json, Express documents/vsd-import.ts)
 * on agrotrace_test_laravel with a faked Mercury (Http::fake) and recorded pauses: the query (productCode,
 * the origin's INN, harvested_at ± 3 UTC days), the attempts arithmetic and last_error ≤ 500 characters, the 6-call
 * limit and the back-off MERCURY_RETRY_BASE_MS·2^k, the PENDING guard, NULL mercury_code, the claim, the audit row.
 * The stop (review M2): a SIGTERM during the back-off ends the pause at once, and no further Mercury call is made;
 * the handler throws Stopping, so the Consumer requeues the event.
 */

use App\Events\Handlers\VsdImport;
use App\Events\Stopping;
use App\Infrastructure\Mercury\Mercury;
use App\Support\StopSignal;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

/** The DB owner (fixtures and the append-only audit_log's cleanup). */
function vsdOwner(): PDO
{
    $u = parse_url((string) getenv('TEST_DATABASE_URL'));

    return new PDO(sprintf('pgsql:host=%s;port=%d;dbname=%s', $u['host'], $u['port'] ?? 5432, ltrim($u['path'], '/')), $u['user'], $u['pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

/**
 * A region, a farm (INN 502701234075), a MEAT product, a RAW batch harvested 2026-09-01 23:30 UTC and its PENDING VSD.
 *
 * @return array{region: string, org: string, product: string, batch: string, doc: string}
 */
function vsdFixture(?string $mercuryCode = '10.11.11', string $status = 'PENDING'): array
{
    $ids = ['region' => (string) Str::uuid(), 'org' => (string) Str::uuid(), 'product' => (string) Str::uuid(),
        'batch' => (string) Str::uuid(), 'doc' => (string) Str::uuid()];
    $db = vsdOwner();
    $db->prepare('INSERT INTO regions (id, name, code) VALUES (?, ?, ?)')->execute([$ids['region'], 'VSD test region', 'ZZ'.random_int(100, 999)]);
    $db->prepare("INSERT INTO organizations (id, type, name, inn, region_id, trust_rating, status) VALUES (?, 'FARM', 'КФХ VSD-тест', '502701234075', ?, 80, 'ACTIVE')")
        ->execute([$ids['org'], $ids['region']]);
    $db->prepare("INSERT INTO products (id, name, category, loss_norm_percent, mercury_code) VALUES (?, 'Говядина VSD-тест', 'MEAT', 1.00, ?)")
        ->execute([$ids['product'], $mercuryCode]);
    $db->prepare("INSERT INTO batches (id, public_code, product_id, origin_org_id, holder_org_id, kind, mass_kg, harvested_at)
                  VALUES (?, ?, ?, ?, ?, 'RAW', 100.000, '2026-09-01T23:30:00Z')")
        ->execute([$ids['batch'], 'ZZ-VSD-'.bin2hex(random_bytes(4)), $ids['product'], $ids['org'], $ids['org']]);
    $db->prepare("INSERT INTO batch_documents (id, batch_id, kind, import_status) VALUES (?, ?, 'VSD', ?)")->execute([$ids['doc'], $ids['batch'], $status]);

    return $ids;
}

/** @param  array{region: string, org: string, product: string, batch: string, doc: string}  $f */
function vsdCleanup(array $f, string $eventId): void
{
    $db = vsdOwner();
    $db->prepare('DELETE FROM audit_log WHERE entity_id = ?')->execute([$f['doc']]);
    $db->prepare('DELETE FROM processed_events WHERE event_id = ?')->execute([$eventId]);
    $db->prepare('DELETE FROM batch_documents WHERE id = ?')->execute([$f['doc']]);
    $db->prepare('DELETE FROM batches WHERE id = ?')->execute([$f['batch']]);
    $db->prepare('DELETE FROM products WHERE id = ?')->execute([$f['product']]);
    $db->prepare('DELETE FROM organizations WHERE id = ?')->execute([$f['org']]);
    $db->prepare('DELETE FROM regions WHERE id = ?')->execute([$f['region']]);
}

function vsdEnvelope(string $eventId, string $docId): stdClass
{
    return json_decode(json_encode(['id' => $eventId, 'type' => 'vsd.import', 'occurredAt' => '2026-10-22T10:00:00.000Z',
        'backend' => 'laravel', 'requestId' => null, 'data' => ['documentId' => $docId, 'batchId' => null, 'publicCode' => 'ZZ']]));
}

/** @return array<string, mixed> */
function vsdDocument(array $over = []): array
{
    return ['uuid' => '3f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0', 'number' => 'VSD-2026-000012', 'issueDate' => '2026-09-01',
        'status' => 'CONFIRMED', 'product' => ['code' => '10.11.11', 'name' => 'Говядина'], 'volume' => ['value' => 100, 'unit' => 'кг'],
        'consignor' => ['inn' => '502701234075', 'name' => 'КФХ'], 'consignee' => ['inn' => '7701234567', 'name' => 'ООО'], ...$over];
}

function vsdRow(string $docId): object
{
    return DB::selectOne('SELECT import_status, attempts, last_error, external_uuid::text AS external_uuid, number FROM batch_documents WHERE id = ?', [$docId]);
}

function vsdClaimed(string $eventId): bool
{
    return DB::selectOne('SELECT 1 AS one FROM processed_events WHERE event_id = ?', [$eventId]) !== null;
}

beforeEach(function () {
    $this->requireDatabase();
    $this->eventId = (string) Str::uuid();
    $this->sleeps = [];
    $this->sleep = function (int $ms) {
        $this->sleeps[] = $ms;
    };
});

afterEach(function () {
    if (isset($this->f)) {
        vsdCleanup($this->f, $this->eventId);
    }
});

it('two failed calls, then the document: IMPORTED with attempts 3, the back-off base·2^k, the query of the schema, claimed and audited', function () {
    $this->f = vsdFixture();
    $n = 0;
    Http::fake(function () use (&$n) {
        return ++$n <= 2 ? Http::response('down', 503)
            : Http::response(['items' => [vsdDocument(['number' => 'A']), vsdDocument(['uuid' => '4f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0', 'number' => 'B']),
                vsdDocument(['uuid' => '5f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0', 'number' => 'Z', 'status' => 'WITHDRAWN'])]]);
    });
    (new VsdImport(new Mercury('http://mercury.test'), $this->sleep, 100))->handle(vsdEnvelope($this->eventId, $this->f['doc']));
    // harvested 2026-09-01 23:30 UTC → the window is the UTC dates 2026-08-29 … 2026-09-04.
    Http::assertSent(fn (Request $r) => $r->url() === 'http://mercury.test/api/v1/vsd?productCode=10.11.11&senderInn=502701234075&dateFrom=2026-08-29&dateTo=2026-09-04');
    expect($n)->toBe(3);
    expect($this->sleeps)->toBe([100, 200]);
    $row = vsdRow($this->f['doc']);
    expect($row->import_status)->toBe('IMPORTED');
    expect((int) $row->attempts)->toBe(3);
    expect($row->last_error)->toBeNull();
    expect($row->number)->toBe('B'); // the greatest number among CONFIRMED of the same date
    expect(vsdClaimed($this->eventId))->toBeTrue();
    $audit = DB::select("SELECT action, entity_type, actor_id FROM audit_log WHERE entity_id = ? AND action = 'system.vsdImport'", [$this->f['doc']]);
    expect(count($audit))->toBe(1);
    expect($audit[0]->entity_type)->toBe('batchDocument');
    expect($audit[0]->actor_id)->toBeNull();
});

it('six failed calls: FAILED with attempts 6, last_error cut to 500 characters, pauses 2^k for the five between', function () {
    $this->f = vsdFixture();
    $calls = 0;
    Http::fake(function () use (&$calls) {
        $calls++;
        throw new ConnectionException(str_repeat('x', 800));
    });
    (new VsdImport(new Mercury('http://mercury.test'), $this->sleep, 10))->handle(vsdEnvelope($this->eventId, $this->f['doc']));
    expect($calls)->toBe(VsdImport::MERCURY_CALLS);
    expect($this->sleeps)->toBe([10, 20, 40, 80, 160]);
    $row = vsdRow($this->f['doc']);
    expect($row->import_status)->toBe('FAILED');
    expect((int) $row->attempts)->toBe(6);
    expect(mb_strlen((string) $row->last_error))->toBe(500);
    expect($row->last_error)->toStartWith('mercury: xxx');
    expect(vsdClaimed($this->eventId))->toBeTrue();
});

it('each failure is counted at once (attempts + 1, last_error) while the row is PENDING', function () {
    $this->f = vsdFixture();
    $seen = [];
    Http::fake(['*' => Http::response('', 500)]);
    $sleep = function () use (&$seen) {
        $seen[] = [(int) vsdRow($this->f['doc'])->attempts, vsdRow($this->f['doc'])->last_error];
    };
    (new VsdImport(new Mercury('http://mercury.test'), $sleep, 1))->handle(vsdEnvelope($this->eventId, $this->f['doc']));
    expect($seen)->toBe([[1, 'mercury: HTTP 500'], [2, 'mercury: HTTP 500'], [3, 'mercury: HTTP 500'], [4, 'mercury: HTTP 500'], [5, 'mercury: HTTP 500']]);
    expect((int) vsdRow($this->f['doc'])->attempts)->toBe(6);
});

it('a row no longer PENDING: no Mercury call, only the claim in an otherwise empty transaction', function () {
    $this->f = vsdFixture(status: 'NOT_FOUND');
    Http::fake();
    (new VsdImport(new Mercury('http://mercury.test'), $this->sleep, 1))->handle(vsdEnvelope($this->eventId, $this->f['doc']));
    Http::assertNothingSent();
    expect(vsdRow($this->f['doc'])->import_status)->toBe('NOT_FOUND');
    expect((int) vsdRow($this->f['doc'])->attempts)->toBe(0);
    expect(vsdClaimed($this->eventId))->toBeTrue();
    expect(DB::selectOne('SELECT count(*) AS n FROM audit_log WHERE entity_id = ?', [$this->f['doc']])->n)->toBe(0);
});

it('a product without mercury_code: NOT_FOUND without calling Mercury, attempts 0', function () {
    $this->f = vsdFixture(mercuryCode: null);
    Http::fake();
    (new VsdImport(new Mercury('http://mercury.test'), $this->sleep, 1))->handle(vsdEnvelope($this->eventId, $this->f['doc']));
    Http::assertNothingSent();
    $row = vsdRow($this->f['doc']);
    expect($row->import_status)->toBe('NOT_FOUND');
    expect((int) $row->attempts)->toBe(0);
    expect(vsdClaimed($this->eventId))->toBeTrue();
});

it('an event already claimed (a redelivery) does nothing at all', function () {
    $this->f = vsdFixture();
    vsdOwner()->prepare("INSERT INTO processed_events (event_id, backend) VALUES (?, 'laravel')")->execute([$this->eventId]);
    Http::fake();
    (new VsdImport(new Mercury('http://mercury.test'), $this->sleep, 1))->handle(vsdEnvelope($this->eventId, $this->f['doc']));
    Http::assertNothingSent();
    expect(vsdRow($this->f['doc'])->import_status)->toBe('PENDING');
});

it('a stop during the back-off: no further Mercury call, Stopping thrown, the row PENDING with the attempts so far, unclaimed (M2)', function () {
    $this->f = vsdFixture();
    $calls = 0;
    Http::fake(function () use (&$calls) {
        $calls++;

        return Http::response('', 500);
    });
    $stop = new StopSignal;
    $sleep = function (int $ms) use ($stop) {
        $this->sleeps[] = $ms;
        $stop->raise(); // SIGTERM arrives in the pause
    };
    expect(fn () => (new VsdImport(new Mercury('http://mercury.test'), $sleep, 1000, $stop))->handle(vsdEnvelope($this->eventId, $this->f['doc'])))
        ->toThrow(Stopping::class);
    expect($calls)->toBe(1);
    expect($this->sleeps)->toBe([1000]);
    $row = vsdRow($this->f['doc']);
    expect($row->import_status)->toBe('PENDING');
    expect((int) $row->attempts)->toBe(1);
    expect(vsdClaimed($this->eventId))->toBeFalse();
});

it('the default back-off pause ends at once on a SIGTERM (StopSignal), not after the full 5 s', function () {
    $this->f = vsdFixture();
    $calls = 0;
    Http::fake(function () use (&$calls) {
        $calls++;

        return Http::response('', 500);
    });
    $stop = new StopSignal;
    pcntl_async_signals(true);
    pcntl_signal(SIGALRM, fn () => $stop->raise());
    pcntl_alarm(1);
    $started = microtime(true);
    try {
        expect(fn () => (new VsdImport(new Mercury('http://mercury.test'), null, 5000, $stop))->handle(vsdEnvelope($this->eventId, $this->f['doc'])))
            ->toThrow(Stopping::class);
    } finally {
        pcntl_signal(SIGALRM, SIG_DFL);
    }
    expect(microtime(true) - $started)->toBeLessThan(1.5);
    expect($calls)->toBe(1);
});
