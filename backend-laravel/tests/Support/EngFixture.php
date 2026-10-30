<?php

namespace Tests\Support;

use Illuminate\Support\Str;
use PDO;

/**
 * Rows of the recall/lab DB tests on agrotrace_test_laravel, written as the DB owner (TEST_DATABASE_URL) and removed
 * again by cleanup() — the append-only audit_log included (the app role may not delete from it).
 */
final class EngFixture
{
    /** @var array<string, list<string>> table → ids */
    public array $ids = [];

    public string $region;

    /** The DB owner (fixtures, and the append-only audit_log's cleanup). */
    public static function owner(): PDO
    {
        $u = parse_url((string) getenv('TEST_DATABASE_URL'));

        return new PDO(sprintf('pgsql:host=%s;port=%d;dbname=%s', $u['host'], $u['port'] ?? 5432, ltrim($u['path'], '/')), $u['user'], $u['pass'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    }

    /** @param  list<mixed>  $args */
    public static function exec(string $sql, array $args = []): void
    {
        self::owner()->prepare($sql)->execute($args);
    }

    public function __construct()
    {
        $this->region = $this->add('regions', 'INSERT INTO regions (id, name, code) VALUES (?, ?, ?)',
            fn ($id) => [$id, 'Engine test region', 'ZE'.random_int(100, 999)]);
    }

    /** @param  callable(string): list<mixed>  $args */
    public function add(string $table, string $sql, callable $args): string
    {
        $id = (string) Str::uuid();
        self::exec($sql, $args($id));
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
        self::exec('INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?', [$id, $role]);

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
        self::exec('INSERT INTO batch_links (parent_batch_id, child_batch_id, mass_used_kg) VALUES (?, ?, 10.000)', [$parent, $child]);
    }

    public function labTest(string $batch, string $lab, string $status, string $due): string
    {
        return $this->add('lab_tests', "INSERT INTO lab_tests (id, batch_id, lab_org_id, reason, status, due_at)
            VALUES (?, ?, ?, 'INSPECTOR', ?, now() + ?::interval)", fn ($id) => [$id, $batch, $lab, $status, $due]);
    }

    public function cleanup(): void
    {
        $db = self::owner();
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
        // Other users of the test DB (its inspectors) get the recalls' notifications too.
        $del("DELETE FROM notifications WHERE payload->>'recallId' IN ({in})", $recalls);
        foreach ($batches as $b) {
            $db->prepare("DELETE FROM outbox_events WHERE backend = 'laravel' AND (payload->'data'->>'batchId' = ? OR payload->'data'->>'sourceBatchId' = ?
                OR payload->'data'->'payload'->>'sourceBatchId' = ? OR payload->'data'->'payload'->>'batchId' = ?)")->execute([$b, $b, $b, $b]);
        }
        foreach ($orgs as $o) {
            $db->prepare("DELETE FROM outbox_events WHERE backend = 'laravel' AND payload->'data'->>'organizationId' = ?")->execute([$o]);
        }
        $del('DELETE FROM audit_log WHERE entity_id IN ({in})', $orgs);
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
