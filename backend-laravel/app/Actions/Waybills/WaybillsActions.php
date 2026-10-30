<?php

namespace App\Actions\Waybills;

use App\Actions\Batches\BatchesActions;
use App\Actions\Batches\BatchView;
use App\Actions\Batches\Lifecycle;
use App\Contract\RulesRepo;
use App\Domain\Decimal;
use App\Domain\Rules;
use App\Domain\Strings;
use App\Http\IfMatch;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\WaybillSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Locks;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Db\TxOptions;
use App\Queries\PublicCache;
use App\Queries\Visibility;
use App\Security\Principal;
use App\Support\Iso;
use App\Support\UtcDays;
use Illuminate\Support\Facades\DB;
use stdClass;

/**
 * Waybills (contracts/openapi/paths/waybills.yaml; FR-PROD-04/05, БП-3, R4, R47, R50, R52; the lifecycle
 * contracts/rules/waybill-state-machine.json; Express waybills/service.ts line by line): DRAFT → send (BR-01, BR-06) →
 * SENT → accept (BR-06, BR-07) | reject (R50c recall task reassignment); a DRAFT may be deleted.
 *
 * Visibility (tag Waybills; deleted ones are seen by nobody): FARMER/PROCESSOR/RETAILER — the organization sends it
 * (any status) or receives it (not DRAFT); INSPECTOR and ADMIN — every non-DRAFT, read-only; LAB — none (x-roles).
 * Every mutation locks the waybill first, then its batches `ORDER BY id` in one statement, then recall tasks (R52,
 * P57), and runs its checks over the locked rows; `If-Match` is compared with the locked waybill's version. Every
 * instant written is the transaction's `now()` (P43). The public pages are dropped after the commit, with the DB slot
 * given back first (P61).
 */
final class WaybillsActions
{
    private const LIST_SORT = ['createdAt', 'sentAt', 'acceptedAt', 'number'];

    private const STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'];

    private const COLUMNS = 'w.*, w.created_at::text AS created_at, w.updated_at::text AS updated_at,
        w.sent_at::text AS sent_at, w.accepted_at::text AS accepted_at, w.deleted_at::text AS deleted_at';

    public static function canGo(string $from, string $to): bool
    {
        foreach (RulesRepo::json('waybill-state-machine')['transitions'] as $t) {
            if ($t['from'] === $from && $t['to'] === $to) {
                return true;
            }
        }

        return false;
    }

    private static function notSender(): Problem
    {
        return new Problem(403, ProblemCode::FORBIDDEN, title: 'Not the waybill sender', params: ['reason' => 'NOT_SENDER']);
    }

    private static function notReceiver(): Problem
    {
        return new Problem(403, ProblemCode::FORBIDDEN, title: 'Not the waybill receiver', params: ['reason' => 'NOT_RECEIVER']);
    }

    /** @param  array<string, mixed>  $params */
    private static function businessRule(string $rule, array $params): Problem
    {
        return new Problem(422, ProblemCode::BUSINESS_RULE, rule: $rule, params: $params);
    }

    /** Whether $p sees the waybill (tag Waybills). */
    private static function canSee(Principal $p, object $w): bool
    {
        if ($w->deleted_at !== null) {
            return false;
        }
        if ($p->isParticipant()
            && ($w->sender_org_id === $p->orgId || ($w->receiver_org_id === $p->orgId && $w->status !== 'DRAFT'))) {
            return true;
        }

        return $p->seesAll() && $w->status !== 'DRAFT';
    }

    /**
     * The visibility predicate for lists (alias `w`).
     *
     * @return array{0: string, 1: list<mixed>}
     */
    private static function visibleWhere(Principal $p): array
    {
        $parts = [];
        $bindings = [];
        if ($p->isParticipant()) {
            $parts[] = "(w.sender_org_id = ? OR (w.receiver_org_id = ? AND w.status <> 'DRAFT'))";
            array_push($bindings, $p->orgId, $p->orgId);
        }
        if ($p->seesAll()) {
            $parts[] = "w.status <> 'DRAFT'";
        }

        return $parts === [] ? ['false', []] : ['('.implode(' OR ', $parts).')', $bindings];
    }

    /**
     * Items of the waybills with their batches' publicCode, each list ordered by publicCode (code points).
     *
     * @param  list<string>  $waybillIds
     * @return array<string, list<stdClass>>
     */
    private static function itemsOf(array $waybillIds): array
    {
        if ($waybillIds === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($waybillIds), '?'));
        $out = [];
        foreach (DB::select("SELECT wi.waybill_id, wi.batch_id, b.public_code, wi.mass_declared_kg, wi.mass_actual_kg, wi.discrepancy_act
              FROM waybill_items wi JOIN batches b ON b.id = wi.batch_id WHERE wi.waybill_id IN ({$marks})", $waybillIds) as $r) {
            $out[$r->waybill_id][] = $r;
        }
        foreach ($out as &$list) {
            usort($list, fn ($a, $b) => Strings::compareCodePoints($a->public_code, $b->public_code));
        }

        return $out;
    }

    /**
     * @param  list<stdClass>  $rows
     * @return list<array<string, mixed>>
     */
    private static function views(Principal $p, array $rows): array
    {
        $items = self::itemsOf(array_map(fn ($w) => $w->id, $rows));
        $batchIds = [];
        foreach ($items as $list) {
            foreach ($list as $i) {
                $batchIds[$i->batch_id] = true;
            }
        }
        $batches = [];
        foreach (BatchView::listItems(array_map('strval', array_keys($batchIds))) as $b) {
            $batches[$b['id']] = $b;
        }
        $orgIds = [];
        foreach ($rows as $w) {
            array_push($orgIds, $w->sender_org_id, $w->receiver_org_id);
        }
        $orgs = BatchView::orgRefs($orgIds);
        $has = fn (string ...$roles): bool => array_intersect($p->roles, $roles) !== [];

        return array_map(function (stdClass $w) use ($p, $items, $batches, $orgs, $has): array {
            $actions = [];
            if ($w->status === 'DRAFT' && $w->sender_org_id === $p->orgId && $has('FARMER', 'PROCESSOR')) {
                array_push($actions, 'send', 'delete');
            }
            if ($w->status === 'SENT' && $w->receiver_org_id === $p->orgId && $has('PROCESSOR', 'RETAILER')) {
                array_push($actions, 'accept', 'reject');
            }

            return [
                'id' => $w->id,
                'number' => $w->number,
                'status' => $w->status,
                'sender' => $orgs[$w->sender_org_id],
                'receiver' => $orgs[$w->receiver_org_id],
                'items' => array_map(function (stdClass $i) use ($batches): array {
                    $d = $i->mass_actual_kg === null ? null
                        : Rules::checkDiscrepancy(['declaredKg' => $i->mass_declared_kg, 'actualKg' => $i->mass_actual_kg]);

                    return [
                        'batch' => $batches[$i->batch_id],
                        'massDeclaredKg' => $i->mass_declared_kg,
                        'massActualKg' => $i->mass_actual_kg,
                        'discrepancyPercent' => $d !== null && isset($d['percent']) ? $d['percent'] : null,
                        'discrepancyAct' => $i->discrepancy_act,
                    ];
                }, $items[$w->id] ?? []),
                'createdAt' => Iso::fromPg($w->created_at),
                'sentAt' => Iso::fromPg($w->sent_at),
                'acceptedAt' => Iso::fromPg($w->accepted_at),
                'rejectReason' => $w->reject_reason,
                'version' => (int) $w->version,
                'actions' => $actions,
            ];
        }, $rows);
    }

    /** @return array<string, mixed> */
    private static function audit(stdClass $w): array
    {
        return [
            'status' => $w->status,
            'version' => (int) $w->version,
            'sentAt' => Iso::fromPg($w->sent_at),
            'acceptedAt' => Iso::fromPg($w->accepted_at),
            'rejectReason' => $w->reject_reason,
        ];
    }

    /** @return array<string, mixed> */
    private static function view(Principal $p, string $id): array
    {
        $w = DB::selectOne('SELECT '.self::COLUMNS.' FROM waybills w WHERE w.id = ?', [$id]);

        return self::views($p, [$w])[0];
    }

    /** @return array{currentVersion: int}|null */
    private static function currentVersion(string $id): ?array
    {
        $r = DB::selectOne('SELECT version FROM waybills WHERE id = ?', [$id]);

        return $r !== null ? ['currentVersion' => (int) $r->version] : null;
    }

    private static function conflict(string $id): TxOptions
    {
        return new TxOptions(conflictParams: fn () => self::currentVersion($id));
    }

    /**
     * Locks the waybill, then its batches (R52); 404 for a waybill $p does not see.
     *
     * @return array{0: stdClass, 1: list<array{item: stdClass, batch: stdClass}>} items in publicCode order
     */
    private static function lockAll(Principal $p, string $id): array
    {
        $w = Locks::waybill($id);
        if ($w === null || ! self::canSee($p, $w)) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }
        $items = self::itemsOf([$id])[$id] ?? [];
        $locked = Locks::batches(array_map(fn ($i) => $i->batch_id, $items));

        return [$w, array_map(fn ($i) => ['item' => $i, 'batch' => $locked[$i->batch_id]], $items)];
    }

    /**
     * The same items ordered by batch id (code points) — the order of the batch writes.
     *
     * @param  list<array{item: stdClass, batch: stdClass}>  $items
     * @return list<array{item: stdClass, batch: stdClass}>
     */
    private static function byBatchId(array $items): array
    {
        usort($items, fn ($x, $y) => Strings::compareCodePoints($x['batch']->id, $y['batch']->id));

        return $items;
    }

    /**
     * The view after the commit, then the public pages dropped with no DB slot held (P61). A Redis failure here is a
     * 500 after the commit, as in Express (`dropPublicPages` after `withTx`).
     *
     * @param  list<string>  $codes
     * @return array<string, mixed>
     */
    private static function finish(Principal $p, string $id, array $codes): array
    {
        try {
            return self::view($p, $id);
        } finally {
            // Dropped whatever happens to the view read (T8 review M1).
            if ($codes !== []) {
                SlotHolder::release();
                PublicCache::dropCodes($codes);
            }
        }
    }

    /**
     * listWaybills — direction (participants only, R51), status, counterpartyOrgId, from/to by createdAt (UTC days), q
     * (number or any item's publicCode, case-insensitive); `x-sort` with nulls last, ties by id as text.
     *
     * @return array<string, mixed>
     */
    public static function list(Principal $p, QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(self::LIST_SORT, 'createdAt,desc');
        $text = $q->q();
        $direction = null;
        if ($p->isParticipant()) {
            $direction = $q->enum('direction', ['incoming', 'outgoing']);
        } else {
            $q->notAllowed('direction');
        }
        $statuses = $q->enums('status', self::STATUSES);
        $counterparty = $q->uuid('counterpartyOrgId');
        ['from' => $from, 'to' => $to] = $q->dateRange();
        $q->done();

        [$visible, $bindings] = self::visibleWhere($p);
        $where = ['w.deleted_at IS NULL', $visible];
        if ($direction === 'outgoing') {
            $where[] = 'w.sender_org_id = ?';
            $bindings[] = $p->orgId;
        }
        if ($direction === 'incoming') {
            $where[] = 'w.receiver_org_id = ?';
            $bindings[] = $p->orgId;
        }
        if ($statuses !== null) {
            $where[] = 'w.status IN ('.implode(',', array_fill(0, count($statuses), '?')).')';
            array_push($bindings, ...$statuses);
        }
        if ($counterparty !== null) {
            if ($p->isParticipant()) {
                $where[] = 'CASE WHEN w.sender_org_id = ? THEN w.receiver_org_id ELSE w.sender_org_id END = ?';
                array_push($bindings, $p->orgId, $counterparty);
            } else {
                $where[] = '(w.sender_org_id = ? OR w.receiver_org_id = ?)';
                array_push($bindings, $counterparty, $counterparty);
            }
        }
        [$days, $dayBindings] = UtcDays::range('w.created_at', $from, $to);
        array_push($where, ...$days);
        array_push($bindings, ...$dayBindings);
        if ($text !== null) {
            $where[] = '(position(lower(?) in lower(w.number)) > 0 OR EXISTS (
                SELECT 1 FROM waybill_items wi JOIN batches b ON b.id = wi.batch_id
                 WHERE wi.waybill_id = w.id AND position(lower(?) in lower(b.public_code)) > 0))';
            array_push($bindings, $text, $text);
        }
        $cond = implode(' AND ', $where);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM waybills w WHERE {$cond}", $bindings)->total;
        $order = match ($sort['field']) {
            'sentAt' => 'w.sent_at',
            'acceptedAt' => 'w.accepted_at',
            'number' => 'w.number COLLATE "C"',
            default => 'w.created_at',
        };
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $rows = DB::select('SELECT '.self::COLUMNS." FROM waybills w WHERE {$cond}
            ORDER BY {$order} {$dir} NULLS LAST, w.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]);

        return ['items' => self::views($p, $rows), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /** @return array<string, mixed> */
    public static function get(Principal $p, string $id): array
    {
        $w = DB::selectOne('SELECT '.self::COLUMNS.' FROM waybills w WHERE w.id = ?', [$id]);
        if ($w === null || ! self::canSee($p, $w)) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }

        return self::views($p, [$w])[0];
    }

    /**
     * createWaybill — body (400; a repeated batch is deferred to step 2) → lock the existing batches of the items
     * (`ORDER BY id`) → references in one 400 (receiver notFound/type/self, `items[i].batchId` duplicate/notFound,
     * `items[i].massDeclaredKg` exceedsBatch) → NOT_HOLDER by request order → a DRAFT with `next_waybill_number()`,
     * version 1.
     *
     * @return array<string, mixed>
     */
    public static function create(Principal $p, mixed $body): array
    {
        $input = WaybillSchemas::parseCreate($body);
        $receiverId = strtolower($input['receiverOrgId']);
        $ids = array_map(fn ($i) => strtolower($i['batchId']), $input['items']);
        $id = Tx::run(function () use ($p, $input, $receiverId, $ids): string {
            $locked = Locks::batches($ids);
            $errors = [];
            $receiver = DB::selectOne('SELECT id, type, status FROM organizations WHERE id = ? AND deleted_at IS NULL', [$receiverId]);
            if ($receiver === null || $receiver->status !== 'ACTIVE') {
                $errors['receiverOrgId'] = ['validation.notFound'];
            } elseif ($receiver->type !== 'PROCESSOR' && $receiver->type !== 'RETAILER') {
                $errors['receiverOrgId'] = ['validation.receiver.type'];
            } elseif ($receiver->id === $p->orgId) {
                $errors['receiverOrgId'] = ['validation.receiver.self'];
            }
            $visible = [];
            if ($locked !== []) {
                $lockedIds = array_map('strval', array_keys($locked));
                $marks = implode(',', array_fill(0, count($lockedIds), '?'));
                [$vis, $visBindings] = Visibility::batchVisibleTo($p, 'b.id');
                foreach (DB::select("SELECT b.id FROM batches b WHERE b.id IN ({$marks}) AND b.deleted_at IS NULL AND {$vis}",
                    [...$lockedIds, ...$visBindings]) as $r) {
                    $visible[$r->id] = true;
                }
            }
            $seen = [];
            foreach ($input['items'] as $i => $it) {
                $bid = $ids[$i];
                if (isset($seen[$bid])) {
                    $errors["items[{$i}].batchId"] = ['validation.duplicate'];

                    continue;
                }
                $seen[$bid] = true;
                $b = $locked[$bid] ?? null;
                if ($b === null || ! isset($visible[$bid])) {
                    $errors["items[{$i}].batchId"] = ['validation.notFound'];

                    continue;
                }
                if (Decimal::compare($it['massDeclaredKg'], $b->mass_kg) > 0) {
                    $errors["items[{$i}].massDeclaredKg"] = ['validation.mass.exceedsBatch'];
                }
            }
            if ($errors !== []) {
                throw Problem::validation($errors);
            }
            foreach ($ids as $bid) {
                if ($locked[$bid]->holder_org_id !== $p->orgId) {
                    throw BatchesActions::notHolder($locked[$bid]->public_code);
                }
            }
            $w = DB::selectOne("INSERT INTO waybills (number, sender_org_id, receiver_org_id, status, version, created_by)
                 VALUES (next_waybill_number(), ?, ?, 'DRAFT', 1, ?) RETURNING id, number", [$p->orgId, $receiverId, $p->userId]);
            foreach ($input['items'] as $i => $it) {
                DB::insert('INSERT INTO waybill_items (waybill_id, batch_id, mass_declared_kg) VALUES (?, ?, ?)',
                    [$w->id, $ids[$i], $it['massDeclaredKg']]);
            }
            AuditLog::write($p->userId, 'createWaybill', 'waybill', $w->id, AuditLog::diff(null, [
                'number' => $w->number,
                'senderOrgId' => $p->orgId,
                'receiverOrgId' => $receiverId,
                'status' => 'DRAFT',
                'version' => 1,
                'items' => array_map(fn ($it, $bid) => ['batchId' => $bid, 'massDeclaredKg' => $it['massDeclaredKg']], $input['items'], $ids),
            ]));

            return $w->id;
        });

        return self::view($p, $id);
    }

    /** deleteWaybill — lock → 404 (a DRAFT is seen by its sender only) → NOT_SENDER → If-Match → DRAFT only. */
    public static function remove(Principal $p, string $id, int $version): void
    {
        Tx::run(function () use ($p, $id, $version): void {
            $w = Locks::waybill($id);
            if ($w === null || ! self::canSee($p, $w)) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            if ($w->sender_org_id !== $p->orgId) {
                throw self::notSender();
            }
            IfMatch::check($version, (int) $w->version);
            if (! self::canGo($w->status, 'DELETED')) {
                throw BatchesActions::invalidTransition(['from' => $w->status, 'to' => 'DELETED']);
            }
            $now = Tx::now();
            DB::update('UPDATE waybills SET deleted_at = ?::timestamptz WHERE id = ?', [$now, $id]);
            AuditLog::write($p->userId, 'deleteWaybill', 'waybill', $id, ['deletedAt' => [null, Iso::fromPg($now)]]);
        }, self::conflict($id));
    }

    /**
     * sendWaybill — locks waybill → batches; 404 → NOT_SENDER → If-Match → DRAFT; then per item in publicCode order:
     * NOT_HOLDER, BR-06 (Blocked/Recalled), INVALID_TRANSITION (not Approved/Accepted), BR-01 for RAW batches (the
     * field's treatments, the field itself possibly deleted, R21). Result: SENT, batches InTransit (WAYBILL_SENT),
     * WAYBILL_INCOMING to the receiver, public pages dropped.
     *
     * @return array<string, mixed>
     */
    public static function send(Principal $p, string $id, int $version): array
    {
        $codes = Tx::run(function () use ($p, $id, $version): array {
            [$w, $items] = self::lockAll($p, $id);
            if ($w->sender_org_id !== $p->orgId) {
                throw self::notSender();
            }
            IfMatch::check($version, (int) $w->version);
            if (! self::canGo($w->status, 'SENT')) {
                throw BatchesActions::invalidTransition(['from' => $w->status, 'to' => 'SENT']);
            }
            $now = Tx::now();
            $shipDate = substr((string) Iso::fromPg($now), 0, 10);
            foreach ($items as ['batch' => $b]) {
                if ($b->holder_org_id !== $p->orgId) {
                    throw BatchesActions::notHolder($b->public_code);
                }
                if ($b->status === 'Blocked' || $b->status === 'Recalled') {
                    throw self::businessRule('BR-06', ['publicCode' => $b->public_code, 'status' => $b->status]);
                }
                if (! Lifecycle::canGo($b->status, 'InTransit')) {
                    throw BatchesActions::invalidTransition(['from' => $b->status, 'to' => 'InTransit', 'publicCode' => $b->public_code]);
                }
                if ($b->kind === 'RAW' && $b->field_id !== null) {
                    $treatments = DB::select('SELECT s.name, t.applied_at::text AS applied_at, s.waiting_period_days
                          FROM treatments t JOIN substances s ON s.id = t.substance_id
                         WHERE t.field_id = ? AND t.deleted_at IS NULL', [$b->field_id]);
                    $br01 = Rules::checkWaitingPeriod([
                        'shipDate' => $shipDate,
                        'treatments' => array_map(fn ($t) => [
                            'substance' => $t->name,
                            'appliedAt' => (string) Iso::fromPg($t->applied_at),
                            'waitingPeriodDays' => (int) $t->waiting_period_days,
                        ], $treatments),
                    ]);
                    if (! $br01['ok']) {
                        throw self::businessRule('BR-01', ['publicCode' => $b->public_code, 'until' => $br01['until'], 'substance' => $br01['substance']]);
                    }
                }
            }
            $sent = DB::selectOne("UPDATE waybills SET status = 'SENT', sent_at = ?::timestamptz, version = ? WHERE id = ?
                 RETURNING status, version, sent_at::text AS sent_at, accepted_at::text AS accepted_at, reject_reason",
                [$now, (int) $w->version + 1, $id]);
            AuditLog::write($p->userId, 'sendWaybill', 'waybill', $id, AuditLog::diff(self::audit($w), self::audit($sent)));
            foreach (self::byBatchId($items) as ['batch' => $b]) {
                $v = Lifecycle::transition($b, 'InTransit', 'WAYBILL_SENT', $p->userId);
                AuditLog::write($p->userId, 'sendWaybill', 'batch', $b->id, ['status' => [$b->status, 'InTransit'], 'version' => [(int) $b->version, $v]]);
            }
            $sender = DB::selectOne('SELECT id, name FROM organizations WHERE id = ?', [$p->orgId]);
            Lifecycle::notify('WAYBILL_INCOMING', ['orgIds' => [$w->receiver_org_id]], [
                'waybillId' => $id,
                'number' => $w->number,
                'senderOrgId' => $sender->id,
                'senderName' => $sender->name,
                'itemsCount' => count($items),
            ]);

            return array_map(fn ($i) => $i['batch']->public_code, $items);
        }, self::conflict($id));

        return self::finish($p, $id, $codes);
    }

    /**
     * acceptWaybill — locks; 404 → NOT_RECEIVER → If-Match → SENT → items match the waybill (400 items.mismatch,
     * repeats included — step 6, P36) → per item: BR-06, INVALID_TRANSITION (not InTransit), BR-07 (an act is required
     * above 2 %). Result: ACCEPTED, items keep massActualKg/discrepancyAct, batches Accepted with the receiver as holder
     * and the actual mass.
     *
     * @param  array{items: list<array{batchId: string, massActualKg: string, discrepancyAct?: string}>}  $input
     * @return array<string, mixed>
     */
    public static function accept(Principal $p, string $id, int $version, array $input): array
    {
        $codes = Tx::run(function () use ($p, $id, $version, $input): array {
            [$w, $items] = self::lockAll($p, $id);
            if ($w->receiver_org_id !== $p->orgId) {
                throw self::notReceiver();
            }
            IfMatch::check($version, (int) $w->version);
            if (! self::canGo($w->status, 'ACCEPTED')) {
                throw BatchesActions::invalidTransition(['from' => $w->status, 'to' => 'ACCEPTED']);
            }
            $byBatch = [];
            foreach ($input['items'] as $a) {
                $byBatch[strtolower($a['batchId'])] = $a;
            }
            $mismatch = count($byBatch) !== count($input['items']) || count($byBatch) !== count($items);
            foreach ($items as ['batch' => $b]) {
                $mismatch = $mismatch || ! isset($byBatch[$b->id]);
            }
            if ($mismatch) {
                throw Problem::validation(['items' => ['validation.items.mismatch']]);
            }
            foreach ($items as ['item' => $item, 'batch' => $b]) {
                if ($b->status === 'Blocked' || $b->status === 'Recalled') {
                    throw self::businessRule('BR-06', ['publicCode' => $b->public_code, 'status' => $b->status]);
                }
                if ($b->status !== 'InTransit' || ! Lifecycle::canGo($b->status, 'Accepted')) {
                    throw BatchesActions::invalidTransition(['from' => $b->status, 'to' => 'Accepted', 'publicCode' => $b->public_code]);
                }
                $a = $byBatch[$b->id];
                $d = Rules::checkDiscrepancy(['declaredKg' => $item->mass_declared_kg, 'actualKg' => $a['massActualKg']]);
                if (isset($d['percent']) && $d['actRequired'] && ! array_key_exists('discrepancyAct', $a)) {
                    throw self::businessRule('BR-07', ['publicCode' => $b->public_code, 'percent' => $d['percent']]);
                }
            }
            $now = Tx::now();
            $accepted = DB::selectOne("UPDATE waybills SET status = 'ACCEPTED', accepted_at = ?::timestamptz, version = ? WHERE id = ?
                 RETURNING status, version, sent_at::text AS sent_at, accepted_at::text AS accepted_at, reject_reason",
                [$now, (int) $w->version + 1, $id]);
            AuditLog::write($p->userId, 'acceptWaybill', 'waybill', $id, AuditLog::diff(self::audit($w), self::audit($accepted)));
            foreach (self::byBatchId($items) as ['batch' => $b]) {
                $a = $byBatch[$b->id];
                DB::update('UPDATE waybill_items SET mass_actual_kg = ?, discrepancy_act = ? WHERE waybill_id = ? AND batch_id = ?',
                    [$a['massActualKg'], $a['discrepancyAct'] ?? null, $id, $b->id]);
                $v = Lifecycle::transition($b, 'Accepted', 'WAYBILL_ACCEPTED', $p->userId, [
                    'holder_org_id' => $p->orgId,
                    'mass_kg' => $a['massActualKg'],
                ]);
                AuditLog::write($p->userId, 'acceptWaybill', 'batch', $b->id, AuditLog::diff(
                    ['status' => $b->status, 'version' => (int) $b->version, 'holderOrgId' => $b->holder_org_id, 'massKg' => $b->mass_kg],
                    ['status' => 'Accepted', 'version' => $v, 'holderOrgId' => $p->orgId, 'massKg' => $a['massActualKg']],
                ));
            }

            return array_map(fn ($i) => $i['batch']->public_code, $items);
        }, self::conflict($id));

        return self::finish($p, $id, $codes);
    }

    /**
     * rejectWaybill — locks (waybill, batches, then the open recall tasks of the receiver on recalled batches, R52) →
     * 404 → NOT_RECEIVER → If-Match → SENT. InTransit batches back to Approved (WAYBILL_REJECTED); a batch recalled in
     * transit: its OPEN/OVERDUE task held by the receiver goes to the sender (dueAt kept, version + 1) with RECALL_TASK
     * {event: REASSIGNED} to the sender (R50c).
     *
     * @param  array{reason: string}  $input
     * @return array<string, mixed>
     */
    public static function reject(Principal $p, string $id, int $version, array $input): array
    {
        $codes = Tx::run(function () use ($p, $id, $version, $input): array {
            [$w, $items] = self::lockAll($p, $id);
            if ($w->receiver_org_id !== $p->orgId) {
                throw self::notReceiver();
            }
            IfMatch::check($version, (int) $w->version);
            if (! self::canGo($w->status, 'REJECTED')) {
                throw BatchesActions::invalidTransition(['from' => $w->status, 'to' => 'REJECTED']);
            }
            $recalled = [];
            foreach ($items as ['batch' => $b]) {
                if ($b->status === 'Recalled') {
                    $recalled[] = $b->id;
                }
            }
            $taskIds = [];
            if ($recalled !== []) {
                $marks = implode(',', array_fill(0, count($recalled), '?'));
                $taskIds = array_map(fn ($t) => $t->id, DB::select("SELECT id FROM recall_tasks
                     WHERE batch_id IN ({$marks}) AND holder_org_id = ? AND status IN ('OPEN', 'OVERDUE')",
                    [...$recalled, $w->receiver_org_id]));
            }
            $tasks = Locks::recallTasks($taskIds);
            $rejected = DB::selectOne("UPDATE waybills SET status = 'REJECTED', reject_reason = ?, version = ? WHERE id = ?
                 RETURNING status, version, sent_at::text AS sent_at, accepted_at::text AS accepted_at, reject_reason",
                [$input['reason'], (int) $w->version + 1, $id]);
            AuditLog::write($p->userId, 'rejectWaybill', 'waybill', $id, AuditLog::diff(self::audit($w), self::audit($rejected)));
            $changed = [];
            foreach (self::byBatchId($items) as ['batch' => $b]) {
                if ($b->status !== 'InTransit' || ! Lifecycle::canGo($b->status, 'Approved')) {
                    continue;
                }
                $v = Lifecycle::transition($b, 'Approved', 'WAYBILL_REJECTED', $p->userId);
                $changed[] = $b->public_code;
                AuditLog::write($p->userId, 'rejectWaybill', 'batch', $b->id, ['status' => [$b->status, 'Approved'], 'version' => [(int) $b->version, $v]]);
            }
            $codeOf = [];
            foreach ($items as ['batch' => $b]) {
                $codeOf[$b->id] = $b->public_code;
            }
            foreach ($tasks as $t) {
                // Still open and still the receiver's after the lock (a parallel confirm or reassignment wins).
                if ($t->holder_org_id !== $w->receiver_org_id || ($t->status !== 'OPEN' && $t->status !== 'OVERDUE')) {
                    continue;
                }
                $tv = (int) $t->version;
                DB::update('UPDATE recall_tasks SET holder_org_id = ?, version = ? WHERE id = ?', [$w->sender_org_id, $tv + 1, $t->id]);
                AuditLog::write($p->userId, 'rejectWaybill', 'recallTask', $t->id, [
                    'holderOrgId' => [$t->holder_org_id, $w->sender_org_id],
                    'version' => [$tv, $tv + 1],
                ]);
                Lifecycle::notify('RECALL_TASK', ['orgIds' => [$w->sender_org_id]], [
                    'recallId' => $t->recall_id,
                    'taskId' => $t->id,
                    'batchId' => $t->batch_id,
                    'publicCode' => $codeOf[$t->batch_id] ?? null,
                    'dueAt' => Iso::fromPg($t->due_at),
                    'event' => 'REASSIGNED',
                ]);
            }

            return $changed;
        }, self::conflict($id));

        return self::finish($p, $id, $codes);
    }
}
