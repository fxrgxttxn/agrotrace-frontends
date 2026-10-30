<?php

/*
 * AuditLog (review M4; contract AuditEntry, Express modules/audit/service.ts): one row in the operation's transaction,
 * backend `laravel`, ip and request_id from the request context, created_at = the transaction's now(); diff over the
 * changed fields only, a creation lists every non-null field with null before.
 */

use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Support\RequestContext;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

uses(TestCase::class)->group('integration');

/** audit_log is append-only for agrotrace_app: the test's own rows are removed as the DB owner (TEST_DATABASE_URL). */
function ownerPdo(): PDO
{
    $u = parse_url((string) getenv('TEST_DATABASE_URL'));

    return new PDO(sprintf('pgsql:host=%s;port=%d;dbname=%s', $u['host'], $u['port'] ?? 5432, ltrim($u['path'], '/')), $u['user'], $u['pass']);
}

it('computes the diff as Express auditDiff does', function () {
    expect(AuditLog::diff(null, ['name' => 'A', 'inn' => null, 'tags' => []]))->toBe(['name' => [null, 'A'], 'tags' => [null, []]]);
    expect(AuditLog::diff(['name' => 'A', 'n' => 1], ['name' => 'B', 'n' => 1]))->toBe(['name' => ['A', 'B']]);
    expect(AuditLog::diff(['x' => ['a' => 1]], ['x' => ['a' => 1]]))->toBe([]);
    expect(AuditLog::diff(['n' => 1], ['n' => '1']))->toBe(['n' => [1, '1']]);
    expect(AuditLog::diff([], ['gone' => null]))->toBe([]);
});

it('writes the entry in the transaction with the request context and the transaction instant', function () {
    $this->requireDatabase();
    app(RequestContext::class)->begin('audit-req-1', '10.1.2.3');
    $entity = '00000000-0000-4000-8000-0000000000a1';
    ownerPdo()->prepare('DELETE FROM audit_log WHERE entity_id = ?')->execute([$entity]); // leftovers of an aborted run
    [$id, $now] = Tx::run(function () use ($entity) {
        AuditLog::write(null, 'system.test', 'batch', $entity, ['status' => ['Created', 'OnTest']]);
        AuditLog::write(null, 'system.test', 'batch', $entity, []);

        return [DB::selectOne('SELECT max(id) AS id FROM audit_log')->id, Tx::now()];
    });
    try {
        $rows = DB::select('SELECT action, entity_type, entity_id, diff::text AS diff, host(ip) AS ip, backend, request_id,
            created_at::text AS at FROM audit_log WHERE entity_id = ? ORDER BY id', [$entity]);
        expect($rows)->toHaveCount(2);
        expect([$rows[0]->action, $rows[0]->entity_type, $rows[0]->backend, $rows[0]->request_id, $rows[0]->ip])
            ->toBe(['system.test', 'batch', 'laravel', 'audit-req-1', '10.1.2.3']);
        expect($rows[0]->diff)->toBe('{"status": ["Created", "OnTest"]}');
        expect($rows[1]->diff)->toBe('{}');
        expect($rows[0]->at)->toBe($now);
        expect(fn () => AuditLog::write(null, 'x', 'batch', null, []))->toThrow(LogicException::class);
        expect(fn () => Tx::run(fn () => AuditLog::write(null, 'x', 'nope', null, [])))->toThrow(InvalidArgumentException::class);
    } finally {
        ownerPdo()->prepare('DELETE FROM audit_log WHERE entity_id = ?')->execute([$entity]);
    }
    expect($id)->not->toBeNull();
});
