<?php

namespace App\Actions\Batches;

use App\Domain\StateMachine;
use App\Security\FileUrls;
use App\Security\Principal;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;
use LogicException;
use stdClass;

/**
 * The contract's batch views (Express batches/view.ts): `BatchListItem`, `Batch` (with the caller's `actions`), the
 * shared `OrganizationRef` / `ProductRef` (public logo/photo URLs).
 *
 * `actions` (schema `Batch`): the transitions of contracts/rules/state-machine.json from the current status
 * (`availableActions`, file order) the caller may perform — ship (FARMER/PROCESSOR holder), accept/reject
 * (PROCESSOR/RETAILER receiver of a SENT waybill with the batch), process (PROCESSOR holder), putOnSale/sell (RETAILER
 * holder), recall (INSPECTOR), writeOff (holder of the batch's OPEN/OVERDUE recall task, FARMER/PROCESSOR/RETAILER);
 * never the automatic ones. Business rules are not evaluated here.
 */
final class BatchView
{
    private const COLUMNS = <<<'SQL'
        b.id, b.public_code, b.mass_kg, b.status, b.kind, b.harvested_at::text AS harvested_at,
               b.produced_at::text AS produced_at, b.updated_at::text AS updated_at, b.qr_generated_at::text AS qr_generated_at,
               b.test_required, b.test_reason, b.version, b.holder_org_id, b.origin_org_id,
               p.id AS product_id, p.name AS product_name, p.category AS product_category, p.image_file_id AS product_image,
               h.name AS holder_name, h.type AS holder_type, h.logo_file_id AS holder_logo,
               o.name AS origin_name, o.type AS origin_type, o.logo_file_id AS origin_logo,
               f.id AS field_id, f.name AS field_name
        SQL;

    private const FROM = <<<'SQL'
          FROM batches b
          JOIN products p ON p.id = b.product_id
          JOIN organizations h ON h.id = b.holder_org_id
          JOIN organizations o ON o.id = b.origin_org_id
          LEFT JOIN fields f ON f.id = b.field_id
        SQL;

    /** @return array{id: string, name: string, type: string, logoUrl: ?string} */
    public static function orgRef(string $id, string $name, string $type, ?string $logo): array
    {
        return ['id' => $id, 'name' => $name, 'type' => $type, 'logoUrl' => $logo !== null ? FileUrls::public($logo) : null];
    }

    /**
     * OrganizationRef of several organizations, by id.
     *
     * @param  list<string>  $ids
     * @return array<string, array{id: string, name: string, type: string, logoUrl: ?string}>
     */
    public static function orgRefs(array $ids): array
    {
        $ids = array_values(array_unique($ids));
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $out = [];
        foreach (DB::select("SELECT id, name, type, logo_file_id FROM organizations WHERE id IN ({$marks})", $ids) as $o) {
            $out[$o->id] = self::orgRef($o->id, $o->name, $o->type, $o->logo_file_id);
        }

        return $out;
    }

    /**
     * `BatchListItem` of $ids, in the order of $ids (missing ids skipped).
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    public static function listItems(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $byId = [];
        foreach (DB::select('SELECT '.self::COLUMNS.self::FROM." WHERE b.id IN ({$marks})", array_values(array_unique($ids))) as $r) {
            $byId[$r->id] = $r;
        }
        $out = [];
        foreach ($ids as $id) {
            if (isset($byId[$id])) {
                $out[] = self::listItem($byId[$id]);
            }
        }

        return $out;
    }

    /** @return array<string, mixed> */
    public static function listItem(stdClass $r): array
    {
        return [
            'id' => $r->id,
            'publicCode' => $r->public_code,
            'product' => [
                'id' => $r->product_id,
                'name' => $r->product_name,
                'category' => $r->product_category,
                'imageUrl' => $r->product_image !== null ? FileUrls::public($r->product_image) : null,
            ],
            'massKg' => $r->mass_kg,
            'status' => $r->status,
            'kind' => $r->kind,
            'holder' => self::orgRef($r->holder_org_id, $r->holder_name, $r->holder_type, $r->holder_logo),
            'origin' => self::orgRef($r->origin_org_id, $r->origin_name, $r->origin_type, $r->origin_logo),
            'harvestedAt' => Iso::fromPg($r->harvested_at),
            'producedAt' => Iso::fromPg($r->produced_at),
            'updatedAt' => Iso::fromPg($r->updated_at),
            'qrGeneratedAt' => Iso::fromPg($r->qr_generated_at),
        ];
    }

    /**
     * The `Batch` card of $id for $p (the caller checked visibility).
     *
     * @return array<string, mixed>
     */
    public static function card(string $id, Principal $p): array
    {
        $r = DB::selectOne('SELECT '.self::COLUMNS.', x.receiver_of_sent, x.task_holder'.self::FROM."
            CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM waybills w JOIN waybill_items wi ON wi.waybill_id = w.id
                       WHERE wi.batch_id = b.id AND w.status = 'SENT' AND w.deleted_at IS NULL AND w.receiver_org_id = ?) AS receiver_of_sent,
                     EXISTS (SELECT 1 FROM recall_tasks t WHERE t.batch_id = b.id
                       AND t.holder_org_id = ? AND t.status IN ('OPEN', 'OVERDUE')) AS task_holder) x
            WHERE b.id = ?", [$p->orgId, $p->orgId, $id]);
        if ($r === null) {
            throw new LogicException("batch {$id} vanished");
        }
        $holder = $r->holder_org_id === $p->orgId;
        $has = fn (string ...$roles): bool => array_intersect($roles, $p->roles) !== [];
        $actions = array_values(array_filter(StateMachine::availableActions($r->status), fn (array $a): bool => match ($a['action']) {
            'ship' => $has('FARMER', 'PROCESSOR') && $holder,
            'accept', 'reject' => $has('PROCESSOR', 'RETAILER') && $r->receiver_of_sent === true,
            'process' => $has('PROCESSOR') && $holder,
            'putOnSale', 'sell' => $has('RETAILER') && $holder,
            'recall' => $has('INSPECTOR'),
            'writeOff' => $has('FARMER', 'PROCESSOR', 'RETAILER') && $r->task_holder === true,
            default => false,
        }));

        return [
            ...self::listItem($r),
            'field' => $r->field_id !== null ? ['id' => $r->field_id, 'name' => $r->field_name] : null,
            'testRequired' => $r->test_required === true,
            'testReason' => $r->test_reason,
            'version' => (int) $r->version,
            'actions' => $actions,
        ];
    }
}
