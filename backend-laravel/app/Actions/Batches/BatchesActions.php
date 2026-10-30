<?php

namespace App\Actions\Batches;

use App\Domain\Dates;
use App\Domain\Rules;
use App\Domain\StateMachine;
use App\Domain\Strings;
use App\Http\IfMatch;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\BatchSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Db\TxOptions;
use App\Infrastructure\Outbox\Outbox;
use App\Queries\PublicCache;
use App\Queries\Visibility;
use App\Security\FileUrls;
use App\Security\Principal;
use App\Support\Iso;
use App\Support\UtcDays;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * Batches (contracts/openapi/paths/batches.yaml; FR-PROD-03/07/08, R20, R42–R45, R49, R51, D14, D16, D18; Express
 * batches/service.ts): list, registration with the BR-03 risk model and the lab assignment, card, history, path,
 * graph, sale. QR — QrActions, documents — App\Actions\Documents. Visibility — App\Queries\Visibility::batchVisibleTo.
 */
final class BatchesActions
{
    private const LIST_SORT = ['publicCode', 'massKg', 'updatedAt', 'harvestedAt', 'producedAt'];

    /** Lab tests that count as a laboratory's load (D18). */
    private const LAB_LOAD_STATUSES = "('QUEUED', 'SAMPLED', 'ESCALATED')";

    public static function notHolder(?string $publicCode = null): Problem
    {
        return new Problem(403, ProblemCode::FORBIDDEN, title: 'Not the batch holder',
            params: ['reason' => 'NOT_HOLDER', ...($publicCode !== null ? ['publicCode' => $publicCode] : [])]);
    }

    /** @param  array<string, mixed>  $params */
    public static function invalidTransition(array $params): Problem
    {
        return new Problem(409, ProblemCode::INVALID_TRANSITION, params: $params);
    }

    /**
     * The non-deleted batch $id if $p sees it, else 404. $lock — `FOR NO KEY UPDATE OF b` first (R47: every check
     * runs on the locked row; the visibility predicate is re-evaluated on it).
     */
    public static function visibleBatch(Principal $p, string $id, bool $lock = false): stdClass
    {
        [$visible, $bindings] = Visibility::batchVisibleTo($p, 'b.id');
        $b = DB::selectOne("SELECT b.*, b.harvested_at::text AS harvested_at, b.produced_at::text AS produced_at,
                b.created_at::text AS created_at, b.updated_at::text AS updated_at, b.qr_generated_at::text AS qr_generated_at,
                {$visible} AS visible
              FROM batches b WHERE b.id = ? AND b.deleted_at IS NULL".($lock ? ' FOR NO KEY UPDATE OF b' : ''),
            [...$bindings, $id]);
        if ($b === null || $b->visible !== true) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }

        return $b;
    }

    /**
     * Audit view of a batch row (API names and formats).
     *
     * @return array<string, mixed>
     */
    public static function audit(stdClass $b): array
    {
        return [
            'publicCode' => $b->public_code,
            'productId' => $b->product_id,
            'originOrgId' => $b->origin_org_id,
            'holderOrgId' => $b->holder_org_id,
            'fieldId' => $b->field_id,
            'kind' => $b->kind,
            'massKg' => $b->mass_kg,
            'harvestedAt' => Iso::fromPg($b->harvested_at),
            'producedAt' => Iso::fromPg($b->produced_at),
            'status' => $b->status,
            'testRequired' => $b->test_required === true,
            'testReason' => $b->test_reason,
            'version' => (int) $b->version,
        ];
    }

    /**
     * listBatches — visible batches, filters joined by AND (R49, R51), `x-sort` (text by code points, nulls last,
     * ties by id as text).
     *
     * @return array<string, mixed>
     */
    public static function list(Principal $p, QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(self::LIST_SORT, 'updatedAt,desc');
        $text = $q->q();
        $statuses = $q->enums('status', StateMachine::statuses());
        $productId = $q->uuid('productId');
        $holder = $q->enum('holder', ['me', 'all']);
        $origin = $q->enum('origin', ['me', 'all']);
        $orgId = null;
        if ($p->seesAll()) {
            $orgId = $q->uuid('orgId');
        } else {
            $q->notAllowed('orgId');
        }
        $kind = $q->enum('kind', ['RAW', 'DERIVED']);
        ['from' => $from, 'to' => $to] = $q->dateRange();
        $q->done();

        [$visible, $bindings] = Visibility::batchVisibleTo($p, 'b.id');
        $where = ['b.deleted_at IS NULL', $visible];
        if ($statuses !== null) {
            $where[] = 'b.status IN ('.implode(',', array_fill(0, count($statuses), '?')).')';
            array_push($bindings, ...$statuses);
        }
        if ($productId !== null) {
            $where[] = 'b.product_id = ?';
            $bindings[] = $productId;
        }
        foreach (['holder_org_id' => $holder, 'origin_org_id' => $origin] as $column => $me) {
            if ($me !== 'me') {
                continue;
            }
            if ($p->isParticipant()) {
                $where[] = "b.{$column} = ?";
                $bindings[] = $p->orgId;
            } else {
                $where[] = 'false';
            }
        }
        if ($orgId !== null) {
            $where[] = '(b.origin_org_id = ? OR b.holder_org_id = ?)';
            array_push($bindings, $orgId, $orgId);
        }
        if ($kind !== null) {
            $where[] = 'b.kind = ?';
            $bindings[] = $kind;
        }
        [$days, $dayBindings] = UtcDays::range("CASE WHEN b.kind = 'RAW' THEN b.harvested_at ELSE b.produced_at END", $from, $to);
        array_push($where, ...$days);
        array_push($bindings, ...$dayBindings);
        if ($text !== null) {
            $where[] = 'position(lower(?) in lower(b.public_code)) > 0';
            $bindings[] = $text;
        }
        $cond = implode(' AND ', $where);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM batches b WHERE {$cond}", $bindings)->total;
        $order = match ($sort['field']) {
            'publicCode' => 'b.public_code COLLATE "C"',
            'massKg' => 'b.mass_kg',
            'harvestedAt' => 'b.harvested_at',
            'producedAt' => 'b.produced_at',
            default => 'b.updated_at',
        };
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $ids = array_map(fn ($r) => $r->id, DB::select("SELECT b.id FROM batches b WHERE {$cond}
            ORDER BY {$order} {$dir} NULLS LAST, b.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]));

        return ['items' => BatchView::listItems($ids), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /**
     * createBatch — one transaction: insert (Created, CREATED by the user) → BR-03 → Approved (TEST_NOT_REQUIRED) or a
     * lab test + OnTest (TEST_REQUIRED) + LAB_ASSIGNED; no ACTIVE lab → 409 NO_LAB_AVAILABLE, everything rolled back
     * (the code sequence value is spent); DAIRY/MEAT → a PENDING VSD row + `vsd.import` (R81).
     *
     * @return array<string, mixed>
     */
    public static function create(Principal $p, mixed $body): array
    {
        $input = BatchSchemas::parseCreate($body);
        $fieldId = strtolower($input['fieldId']);
        $productId = strtolower($input['productId']);
        $id = Tx::run(function () use ($p, $input, $fieldId, $productId): string {
            $errors = [];
            // FOR KEY SHARE with `deleted_at IS NULL` in the locking query (P57, m2): a parallel deleteField (FOR UPDATE)
            // either waits for this batch or commits first, and then the re-checked row is gone → 400 notFound.
            $field = DB::selectOne('SELECT id, region_id FROM fields WHERE id = ? AND organization_id = ? AND deleted_at IS NULL FOR KEY SHARE',
                [$fieldId, $p->orgId]);
            if ($field === null) {
                $errors['fieldId'] = ['validation.notFound'];
            }
            $product = DB::selectOne('SELECT id, name, category FROM products WHERE id = ? AND deleted_at IS NULL FOR SHARE', [$productId]);
            if ($product === null) {
                $errors['productId'] = ['validation.notFound'];
            } elseif ($product->category === 'PROCESSED') {
                $errors['productId'] = ['validation.product.category'];
            }
            $now = (string) Iso::fromPg(Tx::now());
            if (Iso::epochMs($input['harvestedAt']) > Dates::ms($now)) {
                $errors['harvestedAt'] = ['validation.date.future'];
            }
            if ($errors !== []) {
                throw Problem::validation($errors);
            }

            $b = DB::selectOne("INSERT INTO batches (public_code, product_id, origin_org_id, holder_org_id, field_id, kind, mass_kg,
                    harvested_at, status, version, created_by)
                 VALUES (next_batch_code(), ?, ?, ?, ?, 'RAW', ?, ?::timestamptz, 'Created', 1, ?)
                 RETURNING *, harvested_at::text AS harvested_at, produced_at::text AS produced_at",
                [$product->id, $p->orgId, $p->orgId, $field->id, $input['massKg'], $input['harvestedAt'], $p->userId]);
            DB::insert("INSERT INTO batch_status_history (batch_id, from_status, to_status, changed_by, reason, changed_at)
                 VALUES (?, NULL, 'Created', ?, 'CREATED', now())", [$b->id, $p->userId]);

            // BR-03 inputs (contract createBatch step 3).
            $farmBatchCount = (int) DB::selectOne("SELECT count(*) AS n FROM batches
                 WHERE origin_org_id = ? AND kind = 'RAW' AND deleted_at IS NULL AND id <> ?", [$p->orgId, $b->id])->n;
            $trust = DB::selectOne('SELECT trust_rating FROM organizations WHERE id = ?', [$p->orgId])->trust_rating;
            $pesticides = (int) DB::selectOne("SELECT count(*) AS n FROM treatments t JOIN substances s ON s.id = t.substance_id
                 WHERE t.field_id = ? AND t.deleted_at IS NULL AND s.type = 'PESTICIDE'
                   AND t.applied_at >= ?::timestamptz - interval '30 days' AND t.applied_at <= ?::timestamptz",
                [$field->id, $now, $now])->n;
            $risk = Rules::requiresLabTest([
                'publicCode' => $b->public_code,
                'farmBatchCount' => $farmBatchCount,
                'trustRating' => (int) ($trust ?? 0),
                'pesticideTreatmentsLast30Days' => $pesticides,
            ]);
            DB::update('UPDATE batches SET test_required = ?, test_reason = ? WHERE id = ?', [$risk['required'], $risk['reason'], $b->id]);

            if (! $risk['required']) {
                $version = Lifecycle::transition($b, 'Approved', 'TEST_NOT_REQUIRED', null);
                $status = 'Approved';
            } else {
                $lab = self::chooseLab($field->region_id);
                if ($lab === null) {
                    throw new Problem(409, ProblemCode::NO_LAB_AVAILABLE);
                }
                $reason = $risk['reason'] === 'SAMPLED' ? 'PLANNED' : 'RISK';
                $dueAt = Dates::addWorkingDays(['from' => $now, 'days' => 5])['result'];
                $t = DB::selectOne("INSERT INTO lab_tests (batch_id, lab_org_id, reason, status, due_at, created_at, created_by)
                     VALUES (?, ?, ?, 'QUEUED', ?::timestamptz, ?::timestamptz, NULL) RETURNING id",
                    [$b->id, $lab->id, $reason, $dueAt, Tx::now()]);
                AuditLog::write($p->userId, 'createBatch', 'labTest', $t->id, AuditLog::diff(null, [
                    'batchId' => $b->id,
                    'labOrgId' => $lab->id,
                    'reason' => $reason,
                    'status' => 'QUEUED',
                    'dueAt' => $dueAt,
                    'version' => 1,
                ]));
                $version = Lifecycle::transition($b, 'OnTest', 'TEST_REQUIRED', null);
                $status = 'OnTest';
                Lifecycle::notify('LAB_ASSIGNED', ['orgIds' => [$lab->id, $p->orgId]], [
                    'labTestId' => $t->id,
                    'batchId' => $b->id,
                    'publicCode' => $b->public_code,
                    'productName' => $product->name,
                    'labOrgId' => $lab->id,
                    'labName' => $lab->name,
                    'reason' => $reason,
                    'dueAt' => $dueAt,
                ]);
            }
            $b->status = $status;
            $b->version = $version;
            $b->test_required = $risk['required'];
            $b->test_reason = $risk['reason'];
            AuditLog::write($p->userId, 'createBatch', 'batch', $b->id, AuditLog::diff(null, self::audit($b)));

            if ($product->category === 'DAIRY' || $product->category === 'MEAT') {
                $doc = DB::selectOne("INSERT INTO batch_documents (batch_id, kind, import_status, attempts)
                     VALUES (?, 'VSD', 'PENDING', 0) RETURNING id", [$b->id]);
                AuditLog::write($p->userId, 'createBatch', 'batchDocument', $doc->id, AuditLog::diff(null, [
                    'batchId' => $b->id, 'kind' => 'VSD', 'importStatus' => 'PENDING', 'attempts' => 0,
                ]));
                Outbox::enqueue('vsd.import', ['documentId' => $doc->id, 'batchId' => $b->id, 'publicCode' => $b->public_code]);
            }

            return $b->id;
        });

        return BatchView::card($id, $p);
    }

    /** The least-loaded ACTIVE laboratory, the field's region first, ties by id as text (code points); null — none. */
    private static function chooseLab(string $regionId): ?stdClass
    {
        $labs = DB::select('SELECT o.id, o.name, o.region_id,
                (SELECT count(*) FROM lab_tests t WHERE t.lab_org_id = o.id AND t.deleted_at IS NULL
                   AND t.status IN '.self::LAB_LOAD_STATUSES.") AS load
              FROM organizations o WHERE o.type = 'LAB' AND o.status = 'ACTIVE' AND o.deleted_at IS NULL");
        if ($labs === []) {
            return null;
        }
        $local = array_values(array_filter($labs, fn ($l) => $l->region_id === $regionId));
        $pool = $local !== [] ? $local : $labs;
        usort($pool, fn ($a, $b) => ((int) $a->load <=> (int) $b->load) ?: Strings::compareCodePoints($a->id, $b->id));

        return $pool[0];
    }

    /** @return array<string, mixed> */
    public static function get(Principal $p, string $id): array
    {
        self::visibleBatch($p, $id);

        return BatchView::card($id, $p);
    }

    /**
     * getBatchHistory — every row by changed_at, then insertion order.
     *
     * @return list<array<string, mixed>>
     */
    public static function history(Principal $p, string $id): array
    {
        self::visibleBatch($p, $id);
        $rows = DB::select('SELECT h.from_status, h.to_status, h.changed_at::text AS changed_at, h.reason, h.changed_by,
                u.full_name, u.avatar_file_id
              FROM batch_status_history h LEFT JOIN users u ON u.id = h.changed_by
             WHERE h.batch_id = ? ORDER BY h.changed_at, h.id', [$id]);

        return array_map(fn ($h) => [
            'from' => $h->from_status,
            'to' => $h->to_status,
            'changedAt' => Iso::fromPg($h->changed_at),
            'reason' => $h->reason,
            'changedBy' => $h->changed_by !== null && $h->full_name !== null
                ? ['fullName' => $h->full_name, 'avatarUrl' => $h->avatar_file_id !== null ? FileUrls::signed($h->avatar_file_id) : null]
                : null,
        ], $rows);
    }

    /** @return list<array<string, mixed>> */
    public static function path(Principal $p, string $id): array
    {
        return Path::stages(self::visibleBatch($p, $id));
    }

    /**
     * getBatchGraph (FR-PROD-07): parents (depth < 0) and children (depth > 0) up to `depth` levels each way, every
     * node once at its smallest |depth|, no siblings; deleted batches are skipped (and not walked through); nodes
     * outside the caller's visibility `accessible: false`; edges = links between included nodes. Order: nodes by
     * depth, publicCode; edges by parent then child publicCode (code points). Other query parameters are ignored, as
     * in Express.
     *
     * @return array<string, mixed>
     */
    public static function graph(Principal $p, string $id, QueryReader $q): array
    {
        $depth = 2;
        if ($q->has('depth')) {
            $raw = $q->string('depth');
            if ($raw === null || strlen($raw) > 2 || ! ctype_digit($raw) || (int) $raw < 1 || (int) $raw > 5) {
                throw Problem::validation(['depth' => ['validation.range']]);
            }
            $depth = (int) $raw;
        }
        $root = self::visibleBatch($p, $id);
        $nodes = [$root->id => 0];
        foreach (['UP', 'DOWN'] as $dir) {
            $frontier = [$root->id];
            for ($d = 1; $d <= $depth && $frontier !== []; $d++) {
                $marks = implode(',', array_fill(0, count($frontier), '?'));
                [$join, $from] = $dir === 'DOWN' ? ['l.child_batch_id', 'l.parent_batch_id'] : ['l.parent_batch_id', 'l.child_batch_id'];
                $links = DB::select("SELECT b.id FROM batch_links l JOIN batches b ON b.id = {$join}
                     WHERE {$from} IN ({$marks}) AND b.deleted_at IS NULL", $frontier);
                $next = [];
                foreach ($links as $l) {
                    if (array_key_exists($l->id, $nodes)) {
                        continue;
                    }
                    $nodes[$l->id] = $dir === 'UP' ? -$d : $d;
                    $next[] = $l->id;
                }
                $frontier = $next;
            }
        }
        $ids = array_map('strval', array_keys($nodes));
        $marks = implode(',', array_fill(0, count($ids), '?'));
        [$visible, $bindings] = Visibility::batchVisibleTo($p, 'b.id');
        $access = [];
        foreach (DB::select("SELECT b.id, {$visible} AS visible FROM batches b WHERE b.id IN ({$marks})", [...$bindings, ...$ids]) as $r) {
            $access[$r->id] = $r->visible === true;
        }
        $items = [];
        foreach (BatchView::listItems($ids) as $item) {
            $items[$item['id']] = $item;
        }
        $list = array_map(fn (string $nid) => ['item' => $items[$nid], 'depth' => $nodes[$nid]], $ids);
        usort($list, fn ($x, $y) => ($x['depth'] <=> $y['depth']) ?: Strings::compareCodePoints($x['item']['publicCode'], $y['item']['publicCode']));
        $links = DB::select("SELECT parent_batch_id, child_batch_id, mass_used_kg FROM batch_links
             WHERE parent_batch_id IN ({$marks}) AND child_batch_id IN ({$marks})", [...$ids, ...$ids]);
        $code = fn (string $bid): string => $items[$bid]['publicCode'];
        usort($links, fn ($x, $y) => Strings::compareCodePoints($code($x->parent_batch_id), $code($y->parent_batch_id))
            ?: Strings::compareCodePoints($code($x->child_batch_id), $code($y->child_batch_id)));

        return [
            'rootId' => $root->id,
            'depth' => $depth,
            'nodes' => array_map(fn ($n) => [
                'id' => $n['item']['id'],
                'publicCode' => $n['item']['publicCode'],
                'product' => $n['item']['product'],
                'status' => $n['item']['status'],
                'holder' => $n['item']['holder'],
                'depth' => $n['depth'],
                'accessible' => $access[$n['item']['id']] ?? false,
            ], $list),
            'edges' => array_map(fn ($l) => ['parent' => $l->parent_batch_id, 'child' => $l->child_batch_id, 'massUsedKg' => $l->mass_used_kg], $links),
        ];
    }

    /** @return array<string, mixed> */
    public static function putOnSale(Principal $p, string $id, int $version): array
    {
        return self::sale($p, $id, $version, 'OnSale', 'ON_SALE', 'putBatchOnSale');
    }

    /** @return array<string, mixed> */
    public static function markSold(Principal $p, string $id, int $version): array
    {
        return self::sale($p, $id, $version, 'Sold', 'SOLD', 'markBatchSold');
    }

    /**
     * putBatchOnSale / markBatchSold: lock → 404 → 403 NOT_HOLDER → If-Match CAS → INVALID_TRANSITION (R20); the public
     * page cache dropped after the commit.
     *
     * @return array<string, mixed>
     */
    private static function sale(Principal $p, string $id, int $version, string $to, string $reason, string $operationId): array
    {
        $code = Tx::run(function () use ($p, $id, $version, $to, $reason, $operationId): string {
            $b = self::visibleBatch($p, $id, true);
            if ($b->holder_org_id !== $p->orgId) {
                throw self::notHolder();
            }
            IfMatch::check($version, (int) $b->version);
            if (! Lifecycle::canGo($b->status, $to)) {
                throw self::invalidTransition(['from' => $b->status, 'to' => $to]);
            }
            $v = Lifecycle::transition($b, $to, $reason, $p->userId);
            AuditLog::write($p->userId, $operationId, 'batch', $id, ['status' => [$b->status, $to], 'version' => [(int) $b->version, $v]]);

            return $b->public_code;
        }, new TxOptions(conflictParams: fn () => self::currentVersion($id)));
        PublicCache::dropCodes([$code]);

        return BatchView::card($id, $p);
    }

    /** @return array{currentVersion: int}|null */
    public static function currentVersion(string $id): ?array
    {
        $r = DB::selectOne('SELECT version FROM batches WHERE id = ?', [$id]);

        return $r !== null ? ['currentVersion' => (int) $r->version] : null;
    }
}
