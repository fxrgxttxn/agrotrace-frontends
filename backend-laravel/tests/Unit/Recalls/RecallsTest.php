<?php

/*
 * Task 10 on agrotrace_test_laravel (Express recalls/service.ts, rating/rating.ts, events/consumers/recall-requested.ts,
 * rating-recalculate.ts, scheduler/jobs/recall-task-overdue.ts):
 * - createRecall ∥ createRecall on one source, the retry path forced deterministically: the winner (a child process)
 *   commits while the loser's first attempt holds its snapshot; the loser's batch lock fails with 40001, its second
 *   attempt finds the OPEN recall → 201 and 200 with ONE recall, one recall.requested;
 * - BR-09: Math.round exactly as JavaScript; the full fold — events by time, lab before recall at one instant, then id
 *   (code points); deleted tests/batches/recalls and other farms are not counted; recalculate locks the FARM, writes
 *   and audits only a change, ignores other types; a redelivered rating.recalculate does nothing;
 * - recall.requested: OPENED (inspectors, holders, origin) only while OPEN, not deleted, with tasks; RECALL_TASK
 *   CREATED per task; rating.recalculate for a FARM origin with the handled event's requestId; a redelivery writes
 *   nothing;
 * - recall-task-overdue: OPEN past due → OVERDUE (one instant, version + 1, audit, OVERDUE to holder + inspectors,
 *   requestId null); a task held by a confirmation is skipped (SKIP LOCKED) and taken next tick; tasks of a
 *   soft-deleted recall and tasks not yet due are never touched; an OVERDUE task is not escalated again.
 */

use App\Actions\Rating\Rating;
use App\Actions\Recalls\Engine;
use App\Actions\Recalls\RecallsActions;
use App\Domain\Rules;
use App\Events\Handlers\RatingRecalculate;
use App\Events\Handlers\RecallRequested;
use App\Infrastructure\Db\Tx;
use App\Scheduler\Jobs\RecallTaskOverdue;
use App\Security\Principal;
use App\Support\RequestContext;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\EngFixture;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

beforeEach(function () {
    $this->requireDatabase();
    $this->f = new EngFixture;
    $this->events = [];
});

afterEach(function () {
    $this->f->cleanup();
    if ($this->events !== []) {
        EngFixture::exec('DELETE FROM processed_events WHERE event_id IN ('.implode(',', array_fill(0, count($this->events), '?')).')', $this->events);
    }
    app(RequestContext::class)->beginEvent(null);
});

/** @param  array<string, mixed>  $data */
function recEnvelope(string $type, array $data, ?string $requestId = null): stdClass
{
    return json_decode(json_encode(['id' => (string) Str::uuid(), 'type' => $type, 'occurredAt' => '2026-10-26T10:00:00.000Z',
        'backend' => 'laravel', 'requestId' => $requestId, 'data' => $data]));
}

/** @return array<string, mixed> */
function recRequest(string $source): array
{
    return ['sourceBatchId' => $source, 'trigger' => 'INSPECTOR', 'reason' => 'Recalls test', 'blockUpstream' => false,
        'actorId' => null, 'action' => 'createRecall'];
}

it('createRecall ∥ createRecall on one source: the loser\'s retry finds the winner\'s OPEN recall — 201 and 200, one recall', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $authority = $f->org('AUTHORITY');
    $inspector = $f->user($authority, 'INSPECTOR');
    $p = $f->product();
    $src = $f->batch($p, $farm, 'Approved');
    $child = $f->batch($p, $farm, 'Approved');
    $f->link($src, $child);

    $attempts = 0;
    $winner = null;
    DB::listen(function (QueryExecuted $q) use (&$attempts, &$winner, $src, $inspector, $authority) {
        if (str_starts_with($q->sql, 'SET TRANSACTION')) {
            $attempts++;
        }
        // The loser's first statement — its snapshot — is the source check: the winner runs to its commit right now.
        if ($attempts === 1 && $winner === null && str_starts_with($q->sql, 'SELECT id FROM batches WHERE id = ?')) {
            $proc = proc_open([PHP_BINARY, base_path('tests/Fixtures/recalls/create-recall-child.php'), $src, $inspector, $authority],
                [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $out = stream_get_contents($pipes[1]);
            $err = stream_get_contents($pipes[2]);
            $code = proc_close($proc);
            $lines = array_values(array_filter(explode("\n", trim((string) $out))));
            $winner = $code === 0 ? json_decode((string) end($lines), true) : ['error' => $err];
        }
    });
    $loser = RecallsActions::create(new Principal($inspector, $authority, ['INSPECTOR'], false),
        (object) ['sourceBatchId' => $src, 'reason' => 'The loser', 'blockUpstream' => false]);

    expect($winner)->toMatchArray(['status' => 201]);
    expect($attempts)->toBe(2);
    expect($loser['status'])->toBe(200);
    expect($loser['body']['id'])->toBe($winner['id']);
    expect($loser['body']['reason'])->toBe('The winner');
    expect(DB::selectOne('SELECT count(*) AS n FROM recalls WHERE source_batch_id = ?', [$src])->n)->toBe(1);
    expect(DB::selectOne("SELECT count(*) AS n FROM outbox_events WHERE type = 'recall.requested' AND payload->'data'->>'sourceBatchId' = ?", [$src])->n)->toBe(1);
    expect(DB::selectOne('SELECT count(*) AS n FROM recall_tasks WHERE recall_id = ?', [$winner['id']])->n)->toBe(2);
});

it('BR-09 rounds as JavaScript\'s Math.round (half towards +∞) and clamps to [0, 100]', function () {
    $r = fn (int|float $current, string $event) => Rules::nextTrustRating(['current' => $current, 'event' => $event])['rating'];
    expect($r(80, 'LAB_PASS'))->toBe(82);
    expect($r(80.5, 'LAB_PASS'))->toBe(83);
    expect($r(80.4, 'LAB_PASS'))->toBe(82);
    expect($r(80.6, 'LAB_PASS'))->toBe(83);
    expect($r(9.5, 'RECALL_SOURCE'))->toBe(0); // -0.5 → -0 → 0
    expect($r(25.5, 'RECALL_SOURCE'))->toBe(16); // 15.5 → 16
    expect($r(25.4999999999, 'RECALL_SOURCE'))->toBe(15);
    expect($r(99, 'LAB_PASS'))->toBe(100);
    expect($r(5, 'LAB_FAIL'))->toBe(0);
});

it('the fold: by time, lab before recall at one instant, then id; deleted and foreign events are not counted', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $otherFarm = $f->org('FARM');
    $lab = $f->org('LAB');
    $p = $f->product();
    $b = $f->batch($p, $farm, 'Approved');
    $gone = $f->batch($p, $farm, 'Approved', deleted: true);
    $foreign = $f->batch($p, $otherFarm, 'Approved');
    $done = function (string $batch, string $conclusion, string $at, bool $deleted = false) use ($f, $lab): string {
        $id = $f->labTest($batch, $lab, 'QUEUED', '1 day');
        EngFixture::exec("UPDATE lab_tests SET status = 'DONE', conclusion = ?, completed_at = ?::timestamptz, deleted_at = ".($deleted ? 'now()' : 'NULL').' WHERE id = ?', [$conclusion, $at, $id]);

        return $id;
    };
    $recall = function (string $at, bool $deleted = false) use ($b): void {
        EngFixture::exec("INSERT INTO recalls (source_batch_id, trigger, reason, status, opened_at, closed_at, deleted_at) VALUES (?, 'INSPECTOR', 'r', 'CLOSED', ?::timestamptz, ?::timestamptz, "
            .($deleted ? 'now()' : 'NULL').')', [$b, $at, $at]);
    };
    // 80 → (t1) FAIL −15 = 65 → (t2) PASS +2 = 67 and, at the same instant, RECALL −10 = 57 (lab first) → (t3) ×5 PASS = 67.
    // With the recall first at t2 the result would differ only through clamping, so a clamp scenario follows below.
    $done($b, 'FAIL', '2026-01-01T00:00:00Z');
    $done($b, 'PASS', '2026-01-02T00:00:00Z');
    $recall('2026-01-02T00:00:00Z');
    foreach (range(1, 5) as $i) {
        $done($b, 'PASS', "2026-01-03T00:00:0{$i}Z");
    }
    // Not counted: a deleted test, a test of a deleted batch, another farm's test, a deleted recall.
    $done($b, 'FAIL', '2026-01-04T00:00:00Z', deleted: true);
    $done($gone, 'FAIL', '2026-01-04T00:00:00Z');
    $done($foreign, 'FAIL', '2026-01-04T00:00:00Z');
    $recall('2026-01-04T00:00:00Z', deleted: true);
    expect(Tx::run(fn () => Rating::fold($farm)))->toBe(67);
    expect(Tx::run(fn () => Rating::fold($otherFarm)))->toBe(65);

    // Lab before recall at one instant matters at the bounds: 8 × FAIL → 0, then at t: PASS (+2) and RECALL (−10).
    // Lab first: 0 + 2 = 2, − 10 → 0. Recall first would be: 0 − 10 → 0, + 2 = 2.
    $farm2 = $f->org('FARM');
    $b2 = $f->batch($p, $farm2, 'Approved');
    foreach (range(1, 8) as $i) {
        $done($b2, 'FAIL', "2026-02-01T00:00:0{$i}Z");
    }
    $done($b2, 'PASS', '2026-02-02T00:00:00Z');
    EngFixture::exec("INSERT INTO recalls (source_batch_id, trigger, reason, status, opened_at, closed_at) VALUES (?, 'INSPECTOR', 'r', 'CLOSED', '2026-02-02T00:00:00Z', '2026-02-02T00:00:00Z')", [$b2]);
    expect(Tx::run(fn () => Rating::fold($farm2)))->toBe(0);

    // Ties of one kind at one instant go by id (code points). From 100: FAIL first → 85 → 87; PASS first → 100 → 85.
    $farm3 = $f->org('FARM');
    $b3 = $f->batch($p, $farm3, 'Approved');
    foreach (range(1, 9) as $i) {
        $done($b3, 'PASS', "2026-02-28T00:00:0{$i}Z");
    }
    $done($b3, 'PASS', '2026-02-28T00:00:10Z'); // 80 + 10 × 2 = 100
    $tail = substr((string) Str::uuid(), 8);
    $low = '00000000'.$tail;
    $high = 'ffffffff'.$tail;
    foreach ([[$low, 'FAIL'], [$high, 'PASS']] as [$id, $conclusion]) {
        EngFixture::exec("INSERT INTO lab_tests (id, batch_id, lab_org_id, reason, status, conclusion, due_at, completed_at)
            VALUES (?, ?, ?, 'INSPECTOR', 'DONE', ?, now(), '2026-03-01T00:00:00Z')", [$id, $b3, $lab, $conclusion]);
        $f->ids['lab_tests'][] = $id;
    }
    expect(Tx::run(fn () => Rating::fold($farm3)))->toBe(87);
    EngFixture::exec("UPDATE lab_tests SET conclusion = CASE conclusion WHEN 'PASS' THEN 'FAIL' ELSE 'PASS' END WHERE id IN (?, ?)", [$low, $high]);
    expect(Tx::run(fn () => Rating::fold($farm3)))->toBe(85);
});

it('recalculate: a FARM under its lock, written and audited only on a change; other types ignored; redelivery is a no-op', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $lab = $f->org('LAB');
    $p = $f->product();
    $b = $f->batch($p, $farm, 'Approved');
    $t = $f->labTest($b, $lab, 'QUEUED', '1 day');
    EngFixture::exec("UPDATE lab_tests SET status = 'DONE', conclusion = 'FAIL', completed_at = now() WHERE id = ?", [$t]);
    expect(Tx::run(fn () => Rating::recalculate($lab)))->toBe(['before' => null, 'after' => null, 'changed' => false]);
    expect(Tx::run(fn () => Rating::recalculate((string) Str::uuid())))->toBe(['before' => null, 'after' => null, 'changed' => false]);

    $ev = recEnvelope('rating.recalculate', ['organizationId' => $farm, 'cause' => 'LAB_FAIL', 'sourceId' => $t]);
    $this->events[] = $ev->id;
    (new RatingRecalculate)->handle($ev);
    expect(DB::selectOne('SELECT trust_rating FROM organizations WHERE id = ?', [$farm])->trust_rating)->toBe(65);
    $audit = DB::select("SELECT actor_id, entity_type, diff::text AS diff FROM audit_log WHERE action = 'system.ratingRecalculate' AND entity_id = ?", [$farm]);
    expect(count($audit))->toBe(1);
    expect([$audit[0]->actor_id, $audit[0]->entity_type, json_decode($audit[0]->diff, true)])->toBe([null, 'organization', ['trustRating' => [80, 65]]]);
    // The same event again: claimed, nothing. Another event: the fold is unchanged, nothing written or audited.
    EngFixture::exec('UPDATE organizations SET trust_rating = 50 WHERE id = ?', [$farm]);
    (new RatingRecalculate)->handle($ev);
    expect(DB::selectOne('SELECT trust_rating FROM organizations WHERE id = ?', [$farm])->trust_rating)->toBe(50);
    EngFixture::exec('UPDATE organizations SET trust_rating = 65 WHERE id = ?', [$farm]);
    $ev2 = recEnvelope('rating.recalculate', ['organizationId' => $farm, 'cause' => 'LAB_FAIL', 'sourceId' => $t]);
    $this->events[] = $ev2->id;
    (new RatingRecalculate)->handle($ev2);
    expect(Tx::run(fn () => Rating::recalculate($farm)))->toBe(['before' => 65, 'after' => 65, 'changed' => false]);
    expect(DB::selectOne("SELECT count(*) AS n FROM audit_log WHERE action = 'system.ratingRecalculate' AND entity_id = ?", [$farm])->n)->toBe(1);
});

it('recall.requested: OPENED to inspectors, holders and origin; RECALL_TASK per task; rating.recalculate with the event\'s requestId; redelivery writes nothing', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $proc = $f->org('PROCESSOR');
    $authority = $f->org('AUTHORITY');
    $farmer = $f->user($farm, 'FARMER');
    $processor = $f->user($proc, 'PROCESSOR');
    $inspector = $f->user($authority, 'INSPECTOR');
    $p = $f->product();
    $src = $f->batch($p, $farm, 'Approved', $proc);
    $down = $f->batch($p, $proc, 'Approved');
    $f->link($src, $down);
    $out = Tx::run(fn () => Engine::start(recRequest($src)), Engine::RECALL_TX());
    $ev = recEnvelope('recall.requested', ['recallId' => $out->recallId, 'sourceBatchId' => $src, 'trigger' => 'INSPECTOR', 'openedBy' => null], 'req-t10');
    $this->events[] = $ev->id;
    app(RequestContext::class)->beginEvent('req-t10');
    (new RecallRequested)->handle($ev);
    (new RecallRequested)->handle($ev);

    $rows = DB::select("SELECT user_id, type, payload::text AS p FROM notifications WHERE channel = 'IN_APP' AND user_id IN (?, ?, ?)
        ORDER BY type, user_id", [$farmer, $processor, $inspector]);
    $opened = array_values(array_filter($rows, fn ($r) => $r->type === 'RECALL'));
    $created = array_values(array_filter($rows, fn ($r) => $r->type === 'RECALL_TASK'));
    $users = array_map(fn ($r) => $r->user_id, $opened);
    sort($users);
    $want = [$farmer, $processor, $inspector];
    sort($want);
    expect($users)->toBe($want);
    expect(json_decode($opened[0]->p, true))->toEqual(['recallId' => $out->recallId, 'event' => 'OPENED', 'sourceBatchId' => $src,
        'publicCode' => DB::selectOne('SELECT public_code FROM batches WHERE id = ?', [$src])->public_code, 'trigger' => 'INSPECTOR']);
    // Both tasks are held by the processor: two RECALL_TASK CREATED for it, none for the others.
    expect(array_map(fn ($r) => $r->user_id, $created))->toBe([$processor, $processor]);
    $payload = json_decode($created[0]->p, true);
    expect(collect(array_keys($payload))->sort()->values()->all())->toBe(['batchId', 'dueAt', 'event', 'publicCode', 'recallId', 'taskId']);
    expect($payload['event'])->toBe('CREATED');
    $rating = DB::select("SELECT payload::text AS p FROM outbox_events WHERE type = 'rating.recalculate' AND payload->'data'->>'sourceId' = ?", [$out->recallId]);
    expect(count($rating))->toBe(1);
    $env = json_decode($rating[0]->p, true);
    expect($env['requestId'])->toBe('req-t10');
    expect($env['data'])->toEqual(['organizationId' => $farm, 'cause' => 'RECALL_SOURCE', 'sourceId' => $out->recallId]);
});

it('recall.requested: no OPENED for a recall closed or deleted before the handler (R89), the tasks and rating still; no rating for a non-FARM origin', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $proc = $f->org('PROCESSOR');
    $authority = $f->org('AUTHORITY');
    $inspector = $f->user($authority, 'INSPECTOR');
    $processor = $f->user($proc, 'PROCESSOR');
    $p = $f->product();
    $src = $f->batch($p, $farm, 'Approved', $proc);
    $out = Tx::run(fn () => Engine::start(recRequest($src)), Engine::RECALL_TX());
    EngFixture::exec("UPDATE recalls SET status = 'CLOSED', closed_at = now() WHERE id = ?", [$out->recallId]);
    $ev = recEnvelope('recall.requested', ['recallId' => $out->recallId, 'sourceBatchId' => $src, 'trigger' => 'INSPECTOR', 'openedBy' => null]);
    $this->events[] = $ev->id;
    (new RecallRequested)->handle($ev);
    $types = fn () => array_map(fn ($r) => $r->type, DB::select("SELECT type FROM notifications WHERE channel = 'IN_APP' AND user_id IN (?, ?) ORDER BY type", [$inspector, $processor]));
    expect($types())->toBe(['RECALL_TASK']);
    expect(DB::selectOne("SELECT count(*) AS n FROM outbox_events WHERE type = 'rating.recalculate' AND payload->'data'->>'sourceId' = ?", [$out->recallId])->n)->toBe(1);

    // A processor's own batch as the source: no rating event; a deleted recall: no OPENED.
    $own = $f->batch($p, $proc, 'Approved');
    $out2 = Tx::run(fn () => Engine::start(recRequest($own)), Engine::RECALL_TX());
    EngFixture::exec('UPDATE recalls SET deleted_at = now() WHERE id = ?', [$out2->recallId]);
    $ev2 = recEnvelope('recall.requested', ['recallId' => $out2->recallId, 'sourceBatchId' => $own, 'trigger' => 'INSPECTOR', 'openedBy' => null]);
    $this->events[] = $ev2->id;
    (new RecallRequested)->handle($ev2);
    expect($types())->toBe(['RECALL_TASK', 'RECALL_TASK']);
    expect(DB::selectOne("SELECT count(*) AS n FROM outbox_events WHERE type = 'rating.recalculate' AND payload->'data'->>'sourceId' = ?", [$out2->recallId])->n)->toBe(0);
});

it('recall-task-overdue: past due → OVERDUE in one instant; a held task is skipped and taken next tick; a deleted recall\'s and a future task never', function () {
    $f = $this->f;
    $farm = $f->org('FARM');
    $proc = $f->org('PROCESSOR');
    $p = $f->product();
    $mk = function (string $holder) use ($f, $p, $farm): array {
        $src = $f->batch($p, $farm, 'Approved', $holder);
        $out = Tx::run(fn () => Engine::start(recRequest($src)), Engine::RECALL_TX());

        return [$out->recallId, $out->taskIds[0]];
    };
    [, $due] = $mk($proc);
    [, $held] = $mk($proc);
    [, $future] = $mk($proc);
    [$deletedRecall, $hidden] = $mk($proc);
    EngFixture::exec("UPDATE recall_tasks SET due_at = now() - interval '1 minute' WHERE id IN (?, ?, ?)", [$due, $held, $hidden]);
    EngFixture::exec('UPDATE recalls SET deleted_at = now() WHERE id = ?', [$deletedRecall]);

    config(['database.connections.other' => config('database.connections.pgsql')]);
    $other = DB::connection('other');
    $other->beginTransaction();
    $other->select('SELECT id FROM recall_tasks WHERE id = ? FOR NO KEY UPDATE', [$held]);
    try {
        (new RecallTaskOverdue)->tick();
    } finally {
        $other->rollBack();
        $other->disconnect();
    }
    $st = fn (string $id) => DB::selectOne('SELECT status, version, escalated_at::text AS e FROM recall_tasks WHERE id = ?', [$id]);
    expect([$st($due)->status, $st($due)->version])->toBe(['OVERDUE', 2]);
    expect($st($held)->status)->toBe('OPEN');
    expect($st($future)->status)->toBe('OPEN');
    expect([$st($hidden)->status, $st($hidden)->version])->toBe(['OPEN', 1]);
    $note = DB::selectOne("SELECT payload::text AS p FROM outbox_events WHERE type = 'notification.dispatch' AND payload->'data'->'payload'->>'taskId' = ?", [$due]);
    $env = json_decode($note->p, true);
    expect($env['requestId'])->toBeNull();
    expect($env['data']['notificationType'])->toBe('OVERDUE');
    expect($env['data']['recipients'])->toEqual(['userIds' => [], 'orgIds' => [$proc], 'orgHeadIds' => [], 'roles' => ['INSPECTOR']]);
    expect(collect(array_keys($env['data']['payload']))->sort()->values()->all())->toBe(['batchId', 'dueAt', 'holderName', 'holderOrgId', 'publicCode', 'recallId', 'taskId']);
    expect($env['data']['payload']['holderName'])->toBe('Engine PROCESSOR');
    $audit = DB::selectOne("SELECT actor_id, diff::text AS diff FROM audit_log WHERE action = 'system.recallTaskOverdue' AND entity_id = ?", [$due]);
    expect($audit->actor_id)->toBeNull();
    $diff = json_decode($audit->diff, true);
    expect($diff['status'])->toBe(['OPEN', 'OVERDUE']);
    expect($diff['version'])->toBe([1, 2]);

    // Next tick: the held task; the OVERDUE one is not escalated again (one audit row, one notification).
    (new RecallTaskOverdue)->tick();
    expect($st($held)->status)->toBe('OVERDUE');
    expect($st($due)->version)->toBe(2);
    expect(DB::selectOne("SELECT count(*) AS n FROM audit_log WHERE action = 'system.recallTaskOverdue' AND entity_id = ?", [$due])->n)->toBe(1);
    expect(DB::selectOne("SELECT count(*) AS n FROM outbox_events WHERE type = 'notification.dispatch' AND payload->'data'->'payload'->>'taskId' = ?", [$due])->n)->toBe(1);
    expect($st($hidden)->status)->toBe('OPEN');
});
