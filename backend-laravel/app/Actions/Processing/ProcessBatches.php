<?php

namespace App\Actions\Processing;

use App\Actions\Batches\BatchesActions;
use App\Actions\Batches\BatchView;
use App\Actions\Batches\Lifecycle;
use App\Domain\Decimal;
use App\Domain\Rules;
use App\Domain\Strings;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Validation\Schemas\ProcessingSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Locks;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Queries\PublicCache;
use App\Queries\Visibility;
use App\Security\Principal;
use Illuminate\Support\Facades\DB;
use LogicException;

/**
 * processBatches (contracts/openapi/paths/processing.yaml; FR-PROD-06, БП-4, BR-04/05/06, D19, D20, R47; Express
 * processing/service.ts line by line): the inputs of the processor's organization become Processed, each output a new
 * DERIVED batch (Approved, version 2), every (input, output) pair a `batch_links` edge with the input's whole
 * `massUsedKg`.
 *
 * One READ COMMITTED transaction: the existing inputs are locked `FOR NO KEY UPDATE ORDER BY id` in one statement right
 * after the body (Locks::batches), then the output products `FOR SHARE ORDER BY id` — batches before any other row, and
 * no waybill, field or recall task is ever locked here, so there is no cycle with the waybill operations (waybill →
 * batches), createBatch (field → product) or the recall engine (… → batches → tasks). Every check runs over the locked
 * rows, so a parallel sendWaybill or processing of an input waits and then sees the other's result (InTransit/Processed
 * → BR-05, or its own 409). Mass is decimal strings and bcmath only. Every instant written is the transaction's
 * `now()` (P43). No outbox event (as Express). The cards are read after the commit; the public pages of the inputs are
 * dropped with no DB slot held (P61).
 */
final class ProcessBatches
{
    /**
     * @return array{outputs: list<array<string, mixed>>, balance: array{inputKg: string, allowedKg: string, outputKg: string}}
     */
    public static function run(Principal $p, mixed $body): array
    {
        // 1. Body by schema, a repeated input included.
        $input = ProcessingSchemas::parse($body);
        $ids = array_map(fn ($i) => strtolower($i['batchId']), $input['inputs']);
        $productIds = array_map(fn ($o) => strtolower($o['productId']), $input['outputs']);

        ['outputIds' => $outputIds, 'codes' => $codes, 'balance' => $balance] = Tx::run(
            function () use ($p, $input, $ids, $productIds): array {
                $locked = Locks::batches($ids);

                // 2. References — every error of the step in one 400.
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
                $uniqueProducts = array_values(array_unique($productIds));
                $marks = implode(',', array_fill(0, count($uniqueProducts), '?'));
                $products = [];
                foreach (DB::select("SELECT id FROM products WHERE id IN ({$marks}) AND deleted_at IS NULL ORDER BY id FOR SHARE",
                    $uniqueProducts) as $r) {
                    $products[$r->id] = true;
                }
                $errors = [];
                foreach ($input['inputs'] as $i => $it) {
                    $b = $locked[$ids[$i]] ?? null;
                    if ($b === null || ! isset($visible[$b->id])) {
                        $errors["inputs[{$i}].batchId"] = ['validation.notFound'];
                    } elseif (Decimal::compare($it['massUsedKg'], $b->mass_kg) > 0) {
                        $errors["inputs[{$i}].massUsedKg"] = ['validation.mass.exceedsBatch'];
                    }
                }
                foreach ($productIds as $i => $pid) {
                    if (! isset($products[$pid])) {
                        $errors["outputs[{$i}].productId"] = ['validation.notFound'];
                    }
                }
                if ($errors !== []) {
                    throw Problem::validation($errors);
                }

                // 3. Per input in request order: side, BR-06, BR-05.
                $inputs = array_map(fn (string $id) => $locked[$id], $ids);
                foreach ($inputs as $b) {
                    if ($b->holder_org_id !== $p->orgId) {
                        throw BatchesActions::notHolder($b->public_code);
                    }
                    if ($b->status === 'Blocked' || $b->status === 'Recalled') {
                        throw self::businessRule('BR-06', ['publicCode' => $b->public_code, 'status' => $b->status]);
                    }
                    if (! Rules::canUseAsInput(['status' => $b->status])['allowed']) {
                        throw self::businessRule('BR-05', ['publicCode' => $b->public_code, 'status' => $b->status]);
                    }
                }

                // 4. BR-04 with the loss norm of each input's product (numeric text, never a float).
                $inputProducts = array_values(array_unique(array_map(fn (object $b): string => (string) $b->product_id, $inputs)));
                $marks = implode(',', array_fill(0, count($inputProducts), '?'));
                $losses = [];
                foreach (DB::select("SELECT id, loss_norm_percent::text AS loss FROM products WHERE id IN ({$marks})", $inputProducts) as $r) {
                    $losses[$r->id] = $r->loss;
                }
                $mb = Rules::checkMassBalance([
                    'inputs' => array_map(fn (array $it, object $b) => [
                        'massUsedKg' => $it['massUsedKg'],
                        'lossNormPercent' => $losses[$b->product_id],
                    ], $input['inputs'], $inputs),
                    'outputs' => array_map(fn (array $o) => ['massKg' => $o['massKg']], $input['outputs']),
                ]);
                if (isset($mb['error'])) {
                    throw new LogicException("checkMassBalance: {$mb['error']}"); // unreachable: minItems 1
                }
                $totals = ['inputKg' => $mb['inputKg'], 'allowedKg' => $mb['allowedKg'], 'outputKg' => $mb['outputKg']];
                if (! $mb['ok']) {
                    throw self::businessRule('BR-04', $totals);
                }

                // Result: inputs → Processed in id order.
                $now = Tx::now();
                $byId = $inputs;
                usort($byId, fn ($x, $y) => Strings::compareCodePoints($x->id, $y->id));
                foreach ($byId as $b) {
                    $v = Lifecycle::transition($b, 'Processed', 'PROCESSED', $p->userId);
                    AuditLog::write($p->userId, 'processBatches', 'batch', $b->id,
                        ['status' => [$b->status, 'Processed'], 'version' => [(int) $b->version, $v]]);
                }

                // Outputs in request order: Created → Approved, the defensive acyclicity check, links, audit.
                $outputIds = [];
                foreach ($input['outputs'] as $i => $o) {
                    $b = DB::selectOne("INSERT INTO batches (public_code, product_id, origin_org_id, holder_org_id, field_id, kind, mass_kg,
                            harvested_at, produced_at, status, test_required, test_reason, version, created_by, created_at, updated_at)
                         VALUES (next_batch_code(), ?, ?, ?, NULL, 'DERIVED', ?, NULL, ?::timestamptz, 'Created', false, 'NONE', 1, ?,
                            ?::timestamptz, ?::timestamptz)
                         RETURNING *, harvested_at::text AS harvested_at, produced_at::text AS produced_at",
                        [$productIds[$i], $p->orgId, $p->orgId, $o['massKg'], $now, $p->userId, $now, $now]);
                    DB::insert("INSERT INTO batch_status_history (batch_id, from_status, to_status, changed_by, reason, changed_at)
                         VALUES (?, NULL, 'Created', ?, 'CREATED', now())", [$b->id, $p->userId]);
                    $version = Lifecycle::transition($b, 'Approved', 'TEST_NOT_REQUIRED', null);
                    // 5. Defensive acyclicity (п. 7.5): walking up from each parent must never meet the new child.
                    foreach ($inputs as $parent) {
                        if ($parent->id === $b->id || in_array($b->id, self::ancestors($parent->id), true)) {
                            throw new Problem(409, ProblemCode::GRAPH_CYCLE,
                                params: ['parentCode' => $parent->public_code, 'childCode' => $b->public_code]);
                        }
                    }
                    foreach ($inputs as $j => $parent) {
                        DB::insert('INSERT INTO batch_links (parent_batch_id, child_batch_id, mass_used_kg, created_at)
                             VALUES (?, ?, ?, ?::timestamptz)', [$parent->id, $b->id, $input['inputs'][$j]['massUsedKg'], $now]);
                    }
                    $b->status = 'Approved';
                    $b->version = $version;
                    AuditLog::write($p->userId, 'processBatches', 'batch', $b->id, AuditLog::diff(null, [
                        ...BatchesActions::audit($b),
                        'parents' => array_map(fn (object $parent, array $it) => [
                            'batchId' => $parent->id,
                            'massUsedKg' => $it['massUsedKg'],
                        ], $inputs, $input['inputs']),
                    ]));
                    $outputIds[] = $b->id;
                }

                return [
                    'outputIds' => $outputIds,
                    'codes' => array_map(fn ($b) => $b->public_code, $inputs),
                    'balance' => $totals,
                ];
            });

        $outputs = array_map(fn (string $id) => BatchView::card($id, $p), $outputIds);
        SlotHolder::release();
        PublicCache::dropCodes($codes);

        return ['outputs' => $outputs, 'balance' => $balance];
    }

    /** @param  array<string, mixed>  $params */
    private static function businessRule(string $rule, array $params): Problem
    {
        return new Problem(422, ProblemCode::BUSINESS_RULE, rule: $rule, params: $params);
    }

    /**
     * Ancestors of $batchId, all depths (UNION terminates on the acyclic graph and on a corrupt cyclic one).
     *
     * @return list<string>
     */
    private static function ancestors(string $batchId): array
    {
        return array_map(fn ($r) => $r->id, DB::select('WITH RECURSIVE up(id) AS (
                SELECT parent_batch_id FROM batch_links WHERE child_batch_id = ?
                UNION
                SELECT l.parent_batch_id FROM batch_links l JOIN up ON l.child_batch_id = up.id
            ) SELECT id FROM up', [$batchId]));
    }
}
