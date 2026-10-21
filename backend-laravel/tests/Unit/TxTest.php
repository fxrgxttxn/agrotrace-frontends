<?php

/*
 * Tx (R47/R52/R54, Review Focus 1) on agrotrace_test_laravel: 40001/40P01 re-run the whole transaction exactly once,
 * then 409 VERSION_CONFLICT with `currentVersion` from conflictParams; retryIf adds errors to retry; afterCommit
 * effects run only after a commit; nesting is refused; the isolation level is the transaction's first command; now()
 * is one instant per attempt with microseconds.
 */

use App\Http\Problem\Problem;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Db\TxOptions;
use App\Infrastructure\Outbox\Outbox;
use App\Support\Json;
use App\Support\RequestContext;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

beforeEach(function () {
    $this->requireDatabase();
});

function raise(string $sqlstate): void
{
    DB::statement("DO \$\$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '{$sqlstate}'; END \$\$");
}

it('re-runs once on 40001 and 40P01, then answers 409 VERSION_CONFLICT with currentVersion', function (string $state) {
    $attempts = 0;
    try {
        Tx::run(function () use (&$attempts, $state) {
            $attempts++;
            raise($state);
        }, new TxOptions(conflictParams: fn () => ['currentVersion' => 7]));
        $this->fail('no problem');
    } catch (Problem $p) {
        expect($p->status)->toBe(409);
        expect($p->problemCode->value)->toBe('VERSION_CONFLICT');
        expect($p->params)->toBe(['currentVersion' => 7]);
        expect(Json::encode($p->body()))->toContain('"params":{"currentVersion":7}');
    }
    expect($attempts)->toBe(2);
    expect(DB::transactionLevel())->toBe(0);
})->with(['40001', '40P01']);

it('returns the second attempt when only the first fails', function () {
    $attempts = 0;
    $out = Tx::run(function () use (&$attempts) {
        if (++$attempts === 1) {
            raise('40P01');
        }

        return 'done';
    });
    expect($out)->toBe('done');
    expect($attempts)->toBe(2);
});

it('does not retry other errors', function () {
    $attempts = 0;
    expect(function () use (&$attempts) {
        Tx::run(function () use (&$attempts) {
            $attempts++;
            raise('23505');
        });
    })->toThrow(QueryException::class);
    expect($attempts)->toBe(1);
});

it('retries what retryIf accepts (the recall engine\'s 23505), once', function () {
    $attempts = 0;
    $retryIf = fn (Throwable $e) => str_contains($e->getMessage(), 'injected');
    expect(function () use (&$attempts, $retryIf) {
        Tx::run(function () use (&$attempts) {
            $attempts++;
            raise('23505');
        }, new TxOptions(retryIf: $retryIf));
    })->toThrow(Problem::class);
    expect($attempts)->toBe(2);
});

it('runs afterCommit effects after the commit only — never after a rollback or a retried attempt', function () {
    $ran = [];
    Tx::run(function () use (&$ran) {
        Tx::afterCommit(function () use (&$ran) {
            $ran[] = 'committed';
            expect(DB::transactionLevel())->toBe(0);
        });
    });
    expect($ran)->toBe(['committed']);

    $ran = [];
    expect(function () use (&$ran) {
        Tx::run(function () use (&$ran) {
            Tx::afterCommit(function () use (&$ran) {
                $ran[] = 'rolled back';
            });
            throw new RuntimeException('boom');
        });
    })->toThrow(RuntimeException::class);
    expect($ran)->toBe([]);

    $ran = [];
    $attempt = 0;
    Tx::run(function () use (&$ran, &$attempt) {
        $n = ++$attempt;
        Tx::afterCommit(function () use (&$ran, $n) {
            $ran[] = "attempt {$n}";
        });
        if ($n === 1) {
            raise('40001');
        }
    });
    expect($ran)->toBe(['attempt 2']);
});

it('refuses nested transactions', function () {
    expect(fn () => Tx::run(fn () => Tx::run(fn () => 1)))->toThrow(LogicException::class);
    expect(DB::transactionLevel())->toBe(0);
    DB::beginTransaction();
    try {
        expect(fn () => Tx::run(fn () => 1))->toThrow(LogicException::class);
    } finally {
        DB::rollBack();
    }
});

it('sets the isolation level as the first command, read only on request', function () {
    expect(Tx::run(fn () => DB::selectOne('SHOW transaction_isolation')->transaction_isolation))->toBe('read committed');
    expect(Tx::run(
        fn () => DB::selectOne('SHOW transaction_isolation')->transaction_isolation,
        new TxOptions('repeatable read'),
    ))->toBe('repeatable read');
    expect(fn () => Tx::run(
        fn () => DB::statement('CREATE TEMP TABLE tx_ro_probe (x int)'),
        new TxOptions(readOnly: true),
    ))->toThrow(QueryException::class);
    expect(fn () => new TxOptions('read uncommitted'))->toThrow(InvalidArgumentException::class);
});

it('gives one now() per attempt, with microseconds, equal to the statements\' now()', function () {
    [$a, $b, $sql] = Tx::run(fn () => [Tx::now(), Tx::now(), DB::selectOne('SELECT now()::text AS n')->n]);
    expect($a)->toBe($b);
    expect($a)->toBe($sql);
    expect($a)->toMatch('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{1,6}\+00$/');
    expect(fn () => Tx::now())->toThrow(LogicException::class);
});

it('runs every session with the P61 timeouts, UTC and the agrotrace_app role', function () {
    $row = DB::selectOne("SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt,
        current_setting('TimeZone') AS tz, current_user AS who, current_setting('application_name') AS app");
    expect([$row->st, $row->lt, $row->tz, $row->who, $row->app])
        ->toBe(['30s', '10s', 'UTC', 'agrotrace_app', 'agrotrace-laravel-test']);
});

it('writes the outbox envelope in the transaction and hands the id to the request after the commit', function () {
    app(RequestContext::class)->begin('req-outbox-1', '10.0.0.1');
    $id = Tx::run(fn () => Outbox::enqueue('rating.recalculate', ['farmOrgId' => '00000000-0000-4000-8000-000000000001']));
    try {
        $row = DB::selectOne('SELECT backend, type, payload::text AS p FROM outbox_events WHERE id = ?', [$id]);
        expect($row->backend)->toBe('laravel');
        expect($row->type)->toBe('rating.recalculate');
        $env = json_decode($row->p, true);
        expect(array_keys($env))->toEqualCanonicalizing(['id', 'type', 'occurredAt', 'backend', 'requestId', 'data']);
        expect($env['id'])->toBe($id);
        expect($env['requestId'])->toBe('req-outbox-1');
        expect($env['occurredAt'])->toMatch('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/');
        expect($id)->toMatch('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/');
        expect(app(RequestContext::class)->eventIds())->toBe([$id]);

        // A rolled-back attempt leaves neither a row nor an id.
        $lost = null;
        expect(function () use (&$lost) {
            Tx::run(function () use (&$lost) {
                $lost = Outbox::enqueue('rating.recalculate', ['farmOrgId' => '00000000-0000-4000-8000-000000000001']);
                throw new RuntimeException('rollback');
            });
        })->toThrow(RuntimeException::class);
        expect($lost)->not->toBeNull();
        expect(DB::selectOne('SELECT count(*) AS n FROM outbox_events WHERE id = ?', [$lost])->n)->toBe(0);
        expect(app(RequestContext::class)->eventIds())->toBe([$id]);
        expect(fn () => Outbox::enqueue('rating.recalculate', []))->toThrow(LogicException::class);
    } finally {
        DB::delete('DELETE FROM outbox_events WHERE id = ?', [$id]);
    }
});
