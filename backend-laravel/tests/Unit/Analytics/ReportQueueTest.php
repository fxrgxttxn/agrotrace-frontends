<?php

/*
 * The report render queue (App\Actions\Reports\Queue, P52): per container 1 running + 4 waiting; the 6th request is
 * 503 BACKEND_UNAVAILABLE {reason: report-busy} at admission — before any data is read (no SQL at all); an admitted
 * request holds its place while its data is read, and the 120 s deadline counts from admission (waiting included);
 * a client that went away while waiting leaves the queue. Other holders are simulated by flock'ing the lane's slot
 * files from the test (flock holds per open file description).
 */

use App\Actions\Reports\Queue;
use App\Actions\Reports\ReportAborted;
use App\Actions\Reports\ReportsActions;
use App\Http\Problem\Problem;
use App\Http\Query\QueryReader;
use App\Infrastructure\Sandbox\LaneOptions;
use App\Security\Principal;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

uses(TestCase::class);

function queueLane(float $deadline = Queue::DEADLINE_SEC): LaneOptions
{
    return new LaneOptions('report', Queue::WAITING, $deadline, Queue::MEMORY, sys_get_temp_dir().'/agrotrace-lanes-test-'.getmypid().'-'.bin2hex(random_bytes(3)));
}

/** @return resource */
function holdLaneSlot(LaneOptions $o, string $file)
{
    @mkdir($o->dir(), 0777, true);
    $h = fopen($o->dir()."/{$file}", 'c');
    expect(flock($h, LOCK_EX | LOCK_NB))->toBeTrue();

    return $h;
}

function reportBusy(callable $fn): Problem
{
    try {
        $fn();
    } catch (Problem $e) {
        return $e;
    }
    throw new RuntimeException('no Problem');
}

it('admits 1 running + 4 waiting; the next one is 503 report-busy at once', function () {
    $o = queueLane();
    $tickets = [];
    for ($i = 0; $i < 1 + Queue::WAITING; $i++) {
        $tickets[] = Queue::admit($o);
    }
    $started = microtime(true);
    $e = reportBusy(fn () => Queue::admit($o));
    expect(microtime(true) - $started)->toBeLessThan(0.1);
    expect([$e->status, $e->problemCode->value, $e->params])->toBe([503, 'BACKEND_UNAVAILABLE', ['reason' => 'report-busy']]);
    // A released place is free for the next request.
    $tickets[2]->release();
    $tickets[] = Queue::admit($o);
    foreach ($tickets as $t) {
        $t->release();
    }
});

it('downloadReport refuses a full queue before reading any data', function () {
    $o = queueLane();
    config(['agrotrace.sandbox.dir' => dirname($o->dir())]);
    $held = [holdLaneSlot($o, 'run.lock')];
    for ($i = 0; $i < Queue::WAITING; $i++) {
        $held[] = holdLaneSlot($o, "wait-{$i}.lock");
    }
    $queries = 0;
    DB::listen(function () use (&$queries): void {
        $queries++;
    });
    $insp = new Principal('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', ['INSPECTOR'], false);
    $e = reportBusy(fn () => ReportsActions::download($insp, 'batches', new QueryReader('format=xlsx&from=2026-03-01&to=2026-03-01')));
    expect($e->status)->toBe(503);
    expect($e->params)->toBe(['reason' => 'report-busy']);
    expect($queries)->toBe(0);
    // Parameters and access are judged before admission: a 400 / 403 even with the queue full.
    expect(reportBusy(fn () => ReportsActions::download($insp, 'batches', new QueryReader('')))->status)->toBe(400);
    $agronom = new Principal('u', 'o', ['FARMER'], false);
    expect(reportBusy(fn () => ReportsActions::download($agronom, 'batches', new QueryReader('format=xlsx')))->status)->toBe(403);
    expect(reportBusy(fn () => ReportsActions::download($insp, 'nope', new QueryReader('format=xlsx')))->errors)->toBe(['type' => ['validation.enum']]);
    foreach ($held as $h) {
        fclose($h);
    }
});

it('the deadline counts from admission: a ticket that waited past it is 503 without rendering', function () {
    $o = queueLane(0.3);
    $run = holdLaneSlot($o, 'run.lock');
    $ticket = Queue::admit($o); // a waiting place
    usleep(200_000); // its data being read…
    $started = microtime(true);
    $e = reportBusy(fn () => $ticket->render('{}'));
    $ticket->release();
    expect($e->status)->toBe(503);
    expect($e->params)->toBe(['reason' => 'report-busy']);
    expect(microtime(true) - $started)->toBeLessThan(0.25);
    fclose($run);
});

it('a client that went away while waiting gives its place up', function () {
    $o = queueLane();
    $run = holdLaneSlot($o, 'run.lock');
    $ticket = Queue::admit($o);
    $polls = 0;
    expect(fn () => $ticket->render('{}', function () use (&$polls): bool {
        return ++$polls > 2;
    }))->toThrow(ReportAborted::class);
    $ticket->release();
    // Its waiting place is free again: 4 more fit.
    $more = array_map(fn () => Queue::admit($o), range(1, Queue::WAITING));
    expect(fn () => Queue::admit($o))->toThrow(Problem::class);
    foreach ($more as $t) {
        $t->release();
    }
    fclose($run);
});

it('a render that throws is a 500 defect, a child that dies is 503 report-busy', function () {
    $o = queueLane(20.0);
    $ticket = Queue::admit($o);
    expect(fn () => $ticket->render('not json'))->toThrow(RuntimeException::class, 'report rendering failed');
    $ticket->release();
    // Over the child's memory: PHP's fatal error ends it — the lane's `too-complex`, so 503 as a crashed renderer.
    $small = new LaneOptions('report', Queue::WAITING, 20.0, '64M', dirname($o->dir()));
    $rows = array_fill(0, 40000, array_fill(0, 12, ['text', 'ячейка отчёта']));
    $job = json_encode(['format' => 'xlsx', 'title' => 't', 'periodLine' => '', 'generatedLine' => '',
        'generatedAt' => '2026-03-31T10:15:42.123Z', 'fontDir' => null,
        'sheets' => [['name' => 'Лист', 'header' => array_fill(0, 12, 'h'), 'rows' => $rows]]], JSON_THROW_ON_ERROR);
    $ticket = Queue::admit($small);
    $e = reportBusy(fn () => $ticket->render($job));
    $ticket->release();
    expect([$e->status, $e->params])->toBe([503, ['reason' => 'report-busy']]);
});
