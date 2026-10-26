<?php

/*
 * The recall engine core and the lab escalation on agrotrace_test_laravel (tag Recalls steps 1–7; Express
 * recalls/engine.ts, scheduler/jobs/lab-escalation.ts, events/consumers/lab-escalate.ts):
 * - RecallScope walks through soft-deleted batches without making them members, keeps the smallest depth, never
 *   repeats a DOWN member UP, and orders by id;
 * - Engine::start: Recalled transitions where allowed, the InTransit batch's task to the SENT waybill's receiver, BR-08
 *   due dates, one instant (P43), recall.requested always; no task → CLOSED at once with RECALL CLOSED;
 * - RECALL_TX: the open-source race (23505 ux_recalls_open_source) re-runs the transaction with a fresh snapshot,
 *   which reuses the other recall; nothing of the failed attempt remains (no outbox row, no audit row);
 * - lab-escalation: QUEUED/SAMPLED past due → ESCALATED with audit and lab.escalate (requestId null); a test locked
 *   by a request is skipped (SKIP LOCKED), a test of a soft-deleted batch is never escalated;
 * - the lab.escalate handler: claim + LAB_OVERDUE rows in one transaction (lab heads, inspectors); a redelivery
 *   writes nothing.
 */

use App\Actions\Recalls\Engine;
use App\Events\Handlers\LabEscalate;
use App\Infrastructure\Db\Tx;
use App\Queries\RecallScope;
use App\Scheduler\Jobs\LabEscalation;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

/** The DB owner (fixtures, and the append-only audit_log's cleanup). */
function engOwner(): PDO
{
    $u = parse_url((string) getenv('TEST_DATABASE_URL'));

    return new PDO(sprintf('pgsql:host=%s;port=%d;dbname=%s', $u['host'], $u['port'] ?? 5432, ltrim($u['path'], '/')), $u['user'], $u['pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

/** @param  list<mixed>  $args */
function engExec(string $sql, array $args = []): void
{
    engOwner()->prepare($sql)->execute($args);
}

final class EngFixture
{
    /** @var array<string, list<string>> table → ids */
    public array $ids = [];

    public string $region;

    public function __construct()
    {
        $this->region = $this->add('regions', 'INSERT INTO regions (id, name, code) VALUES (?, ?, ?)',
            fn ($id) => [$id, 'Engine test region', 'ZE'.random_int(100, 999)]);
    }

    /** @param  callable(string): list<mixed>  $args */
    public function add(string $table, string $sql, callable $args): string
    {
        $id = (string) Str::uuid();
        engExec($sql, $args($id));
        $this->ids[$table][] = $id;

        return $id;
    }

    public function org(string $type): string
    {
        return $this->add('organizations', 'INSERT INTO organizations (id, type, name, inn, region_id, trust_rating, status)
            VALUES (?, ?, ?, ?, ?, ?, \'ACTIVE\')', fn ($id) => [$id, $type, "Engine {$type}", (string) random_int(1000000000, 9999999999),
            $this->region, $type === 'FARM' ? 80 : null]);
    }

    public function user(string $orgId, string $role, bool $head = false): string
    {
        $id = $this->add('users', 'INSERT INTO users (id, organization_id, email, password_hash, full_name, is_org_admin, status)
            VALUES (?, ?, ?, \'!\', \'Engine user\', ?, \'ACTIVE\')', fn ($id) => [$id, $orgId, "eng-{$id}@test.local", $head ? 'true' : 'false']);
        engExec('INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?', [$id, $role]);

        return $id;
    }

    public function product(): string
    {
        return $this->add('products', "INSERT INTO products (id, name, category, loss_norm_percent) VALUES (?, ?, 'GRAIN', 1.00)",
            fn ($id) => [$id, 'Engine grain '.$id]);
    }

    public function batch(string $product, string $origin, string $status, ?string $holder = null, bool $deleted = false): string
    {
        return $this->add('batches', "INSERT INTO batches (id, public_code, product_id, origin_org_id, holder_org_id, kind, mass_kg,
                harvested_at, status, deleted_at)
            VALUES (?, ?, ?, ?, ?, 'RAW', 100.000, now() - interval '1 day', ?, ".($deleted ? 'now()' : 'NULL').')',
            fn ($id) => [$id, 'ZE-'.substr($id, 0, 13), $product, $origin, $holder ?? $origin, $status]);
    }

    public function link(string $parent, string $child): void
    {
        engExec('INSERT INTO batch_links (parent_batch_id, child_batch_id, mass_used_kg) VALUES (?, ?, 10.000)', [$parent, $child]);
    }

    public function labTest(string $batch, string $lab, string $status, string $due): string
    {
        return $this->add('lab_tests', "INSERT INTO lab_tests (id, batch_id, lab_org_id, reason, status, due_at)
            VALUES (?, ?, ?, 'INSPECTOR', ?, now() + ?::interval)", fn ($id) => [$id, $batch, $lab, $status, $due]);
    }

    public function cleanup(): void
    {
        $db = engOwner();
        $in = fn (string $table) => $this->ids[$table] ?? [];
        $marks = fn (array $ids) => implode(',', array_fill(0, count($ids), '?'));
        $del = function (string $sql, array $ids) use ($db, $marks): void {
            if ($ids !== []) {
                $db->prepare(str_replace('{in}', $marks($ids), $sql))->execute($ids);
            }
        };
        $batches = $in('batches');
        $users = $in('users');
        $orgs = $in('organizations');
        $recalls = $batches === [] ? [] : array_column($db->query('SELECT id FROM recalls WHERE source_batch_id IN (\''.implode("','", $batches).'\')')->fetchAll(), 'id');
        $del('DELETE FROM notifications WHERE user_id IN ({in})', $users);
        foreach ($batches as $b) {
            $db->prepare("DELETE FROM outbox_events WHERE backend = 'laravel' AND (payload->'data'->>'batchId' = ? OR payload->'data'->>'sourceBatchId' = ?
                OR payload->'data'->'payload'->>'sourceBatchId' = ?)")->execute([$b, $b, $b]);
        }
        $tasks = $recalls === [] ? [] : array_column($db->query('SELECT id FROM recall_tasks WHERE recall_id IN (\''.implode("','", $recalls).'\')')->fetchAll(), 'id');
        $del('DELETE FROM audit_log WHERE entity_id IN ({in})', [...$batches, ...$recalls, ...$tasks, ...$in('lab_tests')]);
        $del('DELETE FROM recall_tasks WHERE recall_id IN ({in})', $recalls);
        $del('DELETE FROM recall_batches WHERE recall_id IN ({in})', $recalls);
        $del('UPDATE lab_tests SET recall_id = NULL WHERE recall_id IN ({in})', $recalls);
        $del('DELETE FROM recalls WHERE id IN ({in})', $recalls);
        $del('DELETE FROM lab_tests WHERE id IN ({in})', $in('lab_tests'));
        $del('DELETE FROM batch_links WHERE parent_batch_id IN ({in})', $batches);
        $del('DELETE FROM batch_status_history WHERE batch_id IN ({in})', $batches);
        $del('DELETE FROM waybill_items WHERE batch_id IN ({in})', $batches);
        $del('DELETE FROM waybills WHERE id IN ({in})', $in('waybills'));
        $del('DELETE FROM batches WHERE id IN ({in})', $batches);
        $del('DELETE FROM products WHERE id IN ({in})', $in('products'));
        $del('DELETE FROM user_roles WHERE user_id IN ({in})', $users);
        $del('DELETE FROM users WHERE id IN ({in})', $users);
        $del('DELETE FROM organizations WHERE id IN ({in})', $orgs);
        $del('DELETE FROM regions WHERE id IN ({in})', $in('regions'));
    }
}

beforeEach(function () {
    $this->requireDatabase();
    $this->f = new EngFixture;
});

afterEach(function () {
    $this->f->cleanup();
});

/** @return array<string, mixed> */
function engRequest(string $source, bool $up = false): array
{
    return ['sourceBatchId' => $source, 'trigger' => 'INSPECTOR', 'reason' => 'Engine test', 'blockUpstream' => $up,
        'actorId' => null, 'action' => 'createRecall'];
}

it('walks through soft-deleted batches without members, at the smallest depth; UP never repeats a DOWN member', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $p = $f->product();
    [$a, $b, $c, $d, $u] = [$f->batch($p, $farm, 'Processed'), $f->batch($p, $farm, 'Processed', deleted: true),
        $f->batch($p, $farm, 'Approved'), $f->batch($p, $farm, 'Approved'), $f->batch($p, $farm, 'Processed')];
    // u → a → b(deleted) → c and a → d → c: c at depth 2 either way; u is a's parent (UP).
    $f->link($u, $a);
    $f->link($a, $b);
    $f->link($b, $c);
    $f->link($a, $d);
    $f->link($d, $c);
    $scope = Tx::run(fn () => RecallScope::of($a, true));
    $expected = [
        ['batchId' => $a, 'direction' => 'SOURCE', 'depth' => 0],
        ['batchId' => $c, 'direction' => 'DOWN', 'depth' => 2],
        ['batchId' => $d, 'direction' => 'DOWN', 'depth' => 1],
        ['batchId' => $u, 'direction' => 'UP', 'depth' => 1],
    ];
    usort($expected, fn ($x, $y) => strcmp($x['batchId'], $y['batchId']));
    expect($scope)->toBe($expected);
    // From c upwards: d (1), a (2, through the deleted b or through d), u (3); b itself is no member.
    $up = Tx::run(fn () => RecallScope::of($c, true));
    $byId = array_column($up, null, 'batchId');
    expect($byId[$d]['depth'])->toBe(1);
    expect($byId[$a]['depth'])->toBe(2);
    expect($byId[$u]['depth'])->toBe(3);
    expect(isset($byId[$b]))->toBeFalse();
});

it('start: Recalled where allowed, the InTransit task to the SENT waybill receiver, one instant, recall.requested', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $proc = $f->org('PROCESSOR');
    $shop = $f->org('RETAILER');
    $p = $f->product();
    $src = $f->batch($p, $farm, 'Approved', $proc);
    $transit = $f->batch($p, $proc, 'InTransit');
    $done = $f->batch($p, $proc, 'Processed');
    $f->link($src, $transit);
    $f->link($src, $done);
    $w = $f->add('waybills', "INSERT INTO waybills (id, number, sender_org_id, receiver_org_id, status, sent_at)
        VALUES (?, ?, ?, ?, 'SENT', now())", fn ($id) => [$id, 'WB-ENG-'.substr($id, 0, 8), $proc, $shop]);
    engExec('INSERT INTO waybill_items (waybill_id, batch_id, mass_declared_kg) VALUES (?, ?, 10.000)', [$w, $transit]);

    $out = Tx::run(fn () => Engine::start(engRequest($src)), Engine::RECALL_TX());
    expect($out->created)->toBeTrue();
    expect($out->closed)->toBeFalse();
    expect(count($out->taskIds))->toBe(2);
    $r = DB::selectOne('SELECT status, version, opened_at::text AS opened_at, created_at::text AS created_at FROM recalls WHERE id = ?', [$out->recallId]);
    expect($r->status)->toBe('OPEN');
    expect($r->opened_at)->toBe($r->created_at);
    $tasks = DB::select('SELECT batch_id, holder_org_id, created_at::text AS created_at,
        floor(extract(epoch FROM ?::timestamptz) * 1000) + 86400000 = extract(epoch FROM due_at) * 1000 AS lag FROM recall_tasks WHERE recall_id = ? ORDER BY batch_id',
        [$r->opened_at, $out->recallId]);
    $holders = array_column($tasks, 'holder_org_id', 'batch_id');
    expect($holders)->toEqual([$src => $proc, $transit => $shop]);
    foreach ($tasks as $t) {
        expect($t->created_at)->toBe($r->opened_at);
        // BR-08: +24 h from the opening instant at the millisecond of the API (as Express's JS Date).
        expect($t->lag)->toBeTrue();
    }
    expect(DB::selectOne('SELECT status FROM batches WHERE id = ?', [$done])->status)->toBe('Processed');
    foreach ([$src, $transit] as $b) {
        expect(DB::selectOne('SELECT status FROM batches WHERE id = ?', [$b])->status)->toBe('Recalled');
    }
    expect(DB::selectOne("SELECT count(*) AS n FROM outbox_events WHERE id = ? AND type = 'recall.requested'", [$out->eventIds[0]])->n)->toBe(1);
    // An OPEN recall of the source is reused.
    $again = Tx::run(fn () => Engine::start(engRequest($src)), Engine::RECALL_TX());
    expect($again->created)->toBeFalse();
    expect($again->recallId)->toBe($out->recallId);
});

it('a scope without a transitionable batch closes at once (BR-10): closed_at = opened_at, version 2, RECALL CLOSED', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $p = $f->product();
    $src = $f->batch($p, $farm, 'Sold');
    $out = Tx::run(fn () => Engine::start(engRequest($src)), Engine::RECALL_TX());
    expect($out->closed)->toBeTrue();
    expect($out->taskIds)->toBe([]);
    $r = DB::selectOne('SELECT status, version, opened_at = closed_at AS same FROM recalls WHERE id = ?', [$out->recallId]);
    expect([$r->status, $r->version, $r->same])->toBe(['CLOSED', 2, true]);
    $note = DB::selectOne("SELECT payload->'data' AS d FROM outbox_events WHERE type = 'notification.dispatch'
        AND payload->'data'->'payload'->>'recallId' = ?", [$out->recallId]);
    expect(json_decode($note->d, true))->toMatchArray([
        'notificationType' => 'RECALL',
        'recipients' => ['userIds' => [], 'orgIds' => [], 'orgHeadIds' => [], 'roles' => ['INSPECTOR']],
    ]);
});

it('the open-source race (23505 ux_recalls_open_source) re-runs with a fresh snapshot and reuses the other recall', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $p = $f->product();
    $src = $f->batch($p, $farm, 'Sold'); // not modified by either side: no 40001, the unique index decides
    $attempts = 0;
    $other = null;
    $out = Tx::run(function () use (&$attempts, &$other, $src) {
        $attempts++;
        DB::select('SELECT 1'); // the snapshot
        if ($attempts === 1) {
            $other = (string) Str::uuid();
            engExec("INSERT INTO recalls (id, source_batch_id, trigger, reason, status) VALUES (?, ?, 'INSPECTOR', 'other', 'OPEN')", [$other, $src]);
        }

        return Engine::start(engRequest($src));
    }, Engine::RECALL_TX());
    expect($attempts)->toBe(2);
    expect($out->created)->toBeFalse();
    expect($out->recallId)->toBe($other);
    expect(DB::selectOne('SELECT count(*) AS n FROM recalls WHERE source_batch_id = ?', [$src])->n)->toBe(1);
    expect(DB::selectOne("SELECT count(*) AS n FROM outbox_events WHERE type = 'recall.requested' AND payload->'data'->>'sourceBatchId' = ?", [$src])->n)->toBe(0);
    expect(DB::selectOne('SELECT count(*) AS n FROM audit_log WHERE entity_id = ?', [$src])->n)->toBe(0);
    expect(Engine::isOpenSourceRace(new RuntimeException('x')))->toBeFalse();
});

it('lab-escalation: past-due QUEUED/SAMPLED → ESCALATED; a locked test is skipped; a deleted batch\'s test never', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $lab = $f->org('LAB');
    $p = $f->product();
    $b = $f->batch($p, $farm, 'OnTest');
    $gone = $f->batch($p, $farm, 'OnTest', deleted: true);
    $q = $f->labTest($b, $lab, 'QUEUED', '-1 minute');
    $s = $f->labTest($b, $lab, 'SAMPLED', '-1 minute');
    $locked = $f->labTest($b, $lab, 'QUEUED', '-1 minute');
    $future = $f->labTest($b, $lab, 'QUEUED', '1 hour');
    $deleted = $f->labTest($gone, $lab, 'QUEUED', '-1 minute');
    // Escalation is global: the seeded/other tests of this DB may be escalated too — only ours are looked at.
    config(['database.connections.other' => config('database.connections.pgsql')]);
    $other = DB::connection('other');
    $other->beginTransaction();
    $other->select('SELECT id FROM lab_tests WHERE id = ? FOR NO KEY UPDATE', [$locked]);
    try {
        (new LabEscalation)->tick();
    } finally {
        $other->rollBack();
        $other->disconnect();
    }
    $st = fn (string $id) => DB::selectOne('SELECT status, version, escalated_at IS NOT NULL AS esc FROM lab_tests WHERE id = ?', [$id]);
    expect([$st($q)->status, $st($q)->version, $st($q)->esc])->toBe(['ESCALATED', 2, true]);
    expect($st($s)->status)->toBe('ESCALATED');
    expect($st($locked)->status)->toBe('QUEUED');
    expect($st($future)->status)->toBe('QUEUED');
    expect($st($deleted)->status)->toBe('QUEUED');
    $ev = DB::selectOne("SELECT payload::text AS p FROM outbox_events WHERE type = 'lab.escalate' AND payload->'data'->>'labTestId' = ?", [$q]);
    $env = json_decode($ev->p, true);
    expect($env['requestId'])->toBeNull();
    $keys = array_keys($env['data']);
    sort($keys);
    expect($keys)->toBe(['batchId', 'dueAt', 'escalatedAt', 'labOrgId', 'labTestId', 'publicCode']);
    $audit = DB::selectOne("SELECT actor_id, diff::text AS diff FROM audit_log WHERE action = 'system.labTestEscalate' AND entity_id = ?", [$q]);
    expect($audit->actor_id)->toBeNull();
    expect(json_decode($audit->diff, true)['status'])->toBe(['QUEUED', 'ESCALATED']);
    // The next tick takes the test that was locked.
    (new LabEscalation)->tick();
    expect($st($locked)->status)->toBe('ESCALATED');
});

it('lab.escalate: claim and LAB_OVERDUE in one transaction (lab heads, inspectors); a redelivery writes nothing', function () {
    $f = $this->f;
    $lab = $f->org('LAB');
    $authority = $f->org('AUTHORITY');
    $head = $f->user($lab, 'LAB', true);
    $plain = $f->user($lab, 'LAB');
    $inspector = $f->user($authority, 'INSPECTOR');
    $eventId = (string) Str::uuid();
    $envelope = json_decode(json_encode(['id' => $eventId, 'type' => 'lab.escalate', 'occurredAt' => '2026-10-26T10:00:00.000Z',
        'backend' => 'laravel', 'requestId' => null, 'data' => ['labTestId' => (string) Str::uuid(), 'labOrgId' => $lab,
            'batchId' => (string) Str::uuid(), 'publicCode' => 'ZE-1', 'dueAt' => '2026-10-20T10:00:00.000Z',
            'escalatedAt' => '2026-10-26T10:00:00.000Z']]));
    try {
        (new LabEscalate)->handle($envelope);
        (new LabEscalate)->handle($envelope);
        $rows = DB::select("SELECT user_id, channel, delivery_status, payload::text AS p FROM notifications
            WHERE type = 'LAB_OVERDUE' AND user_id IN (?, ?, ?) ORDER BY user_id, channel", [$head, $plain, $inspector]);
        $by = [];
        foreach ($rows as $r) {
            $by[$r->user_id][] = [$r->channel, $r->delivery_status];
        }
        expect($by)->toHaveKeys([$head, $inspector]);
        expect(isset($by[$plain]))->toBeFalse();
        expect($by[$head])->toBe([['EMAIL', 'PENDING'], ['IN_APP', 'DELIVERED']]);
        expect(json_decode($rows[0]->p, true))->toMatchArray(['labOrgId' => $lab, 'labName' => 'Engine LAB', 'publicCode' => 'ZE-1']);
    } finally {
        engExec('DELETE FROM processed_events WHERE event_id = ?', [$eventId]);
    }
});
