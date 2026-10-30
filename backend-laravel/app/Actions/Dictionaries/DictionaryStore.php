<?php

namespace App\Actions\Dictionaries;

use App\Domain\Decimal;
use App\Http\Problem\Problem;
use App\Security\FileUrls;
use App\Support\Iso;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * The five dictionaries of spec 7.2 (contracts/openapi/paths/dictionaries.yaml, R54/D29; Express dictionaries/
 * store.ts): table layout, API views, audit views (API names and formats) and the row writes shared by the CRUD
 * operations and the import.
 *
 * products, substances, indicators — soft delete (`deleted_at`), unique `name` among all rows (a soft-deleted row keeps
 * its name and is restored by a create/import with that name); norms — hard delete, unique (product, indicator);
 * regions — hard delete, unique `code`, no timestamps. Every writing transaction of a dictionary takes the advisory
 * lock `dictionary:<name>` first (R93): uniqueness checks and the import's lookups see a stable dictionary.
 * Row locks (P23, Global Constraints): rows FOR NO KEY UPDATE; a hard delete FOR UPDATE (one of the two places it is
 * allowed: it must wait for, and then see, a key-share reference being inserted).
 */
final class DictionaryStore
{
    public const NAMES = ['products', 'substances', 'indicators', 'norms', 'regions'];

    public const SOFT_DELETE = ['products' => true, 'substances' => true, 'indicators' => true, 'norms' => false, 'regions' => false];

    public const ENTITY_TYPE = ['products' => 'product', 'substances' => 'substance', 'indicators' => 'indicator', 'norms' => 'norm', 'regions' => 'region'];

    /** Decimal columns: compared numerically (R59 `unchanged`). */
    private const DECIMAL_COLUMNS = ['loss_norm_percent' => true, 'max_value' => true];

    /** `DictionaryName` path parameter → 400 `errors.name: [validation.enum]` for any other value. */
    public static function nameParam(Request $request): string
    {
        $v = $request->route('name');
        if (! is_string($v) || ! in_array($v, self::NAMES, true)) {
            throw Problem::validation(['name' => ['validation.enum']]);
        }

        return $v;
    }

    public static function isNamed(string $name): bool
    {
        return $name !== 'norms' && $name !== 'regions';
    }

    /** Serializes the writes of one dictionary (the first statement of every writing transaction). */
    public static function lock(string $name): void
    {
        DB::select('SELECT pg_advisory_xact_lock(hashtext(?))', ["dictionary:{$name}"]);
    }

    /**
     * Audit view of a row: API field names and formats (decimals as strings, dates ISO, files by id).
     *
     * @param  array<string, mixed>  $r
     * @return array<string, mixed>
     */
    public static function auditView(string $name, array $r): array
    {
        return match ($name) {
            'products' => [
                'name' => $r['name'], 'category' => $r['category'], 'lossNormPercent' => $r['loss_norm_percent'],
                'mercuryCode' => $r['mercury_code'], 'imageFileId' => $r['image_file_id'], 'deletedAt' => Iso::fromPg($r['deleted_at']),
            ],
            'substances' => [
                'name' => $r['name'], 'type' => $r['type'], 'waitingPeriodDays' => (int) $r['waiting_period_days'],
                'deletedAt' => Iso::fromPg($r['deleted_at']),
            ],
            'indicators' => ['name' => $r['name'], 'unit' => $r['unit'], 'deletedAt' => Iso::fromPg($r['deleted_at'])],
            'norms' => ['productId' => $r['product_id'], 'indicatorId' => $r['indicator_id'], 'maxValue' => $r['max_value']],
            default => ['code' => $r['code'], 'name' => $r['name']],
        };
    }

    /**
     * API views (`DictionaryEntry`) of rows of one dictionary, in the given order.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return list<array<string, mixed>>
     */
    public static function views(string $name, array $rows): array
    {
        switch ($name) {
            case 'products':
                return array_map(fn (array $r) => [
                    'id' => $r['id'], 'name' => $r['name'], 'category' => $r['category'],
                    'lossNormPercent' => $r['loss_norm_percent'], 'mercuryCode' => $r['mercury_code'],
                    'imageUrl' => $r['image_file_id'] !== null ? FileUrls::public($r['image_file_id']) : null,
                    'createdAt' => Iso::fromPg($r['created_at']), 'updatedAt' => Iso::fromPg($r['updated_at']),
                    'deletedAt' => Iso::fromPg($r['deleted_at']),
                ], $rows);
            case 'substances':
                return array_map(fn (array $r) => [
                    'id' => $r['id'], 'name' => $r['name'], 'type' => $r['type'],
                    'waitingPeriodDays' => (int) $r['waiting_period_days'],
                    'createdAt' => Iso::fromPg($r['created_at']), 'updatedAt' => Iso::fromPg($r['updated_at']),
                    'deletedAt' => Iso::fromPg($r['deleted_at']),
                ], $rows);
            case 'indicators':
                return array_map(fn (array $r) => [
                    'id' => $r['id'], 'name' => $r['name'], 'unit' => $r['unit'],
                    'createdAt' => Iso::fromPg($r['created_at']), 'updatedAt' => Iso::fromPg($r['updated_at']),
                    'deletedAt' => Iso::fromPg($r['deleted_at']),
                ], $rows);
            case 'regions':
                return array_map(fn (array $r) => ['id' => $r['id'], 'code' => $r['code'], 'name' => $r['name']], $rows);
        }
        if ($rows === []) {
            return [];
        }
        $ids = array_column($rows, 'id');
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $refs = [];
        foreach (DB::select("SELECT n.id, p.name AS product_name, i.name AS indicator_name, i.unit AS indicator_unit
              FROM norms n JOIN products p ON p.id = n.product_id JOIN indicators i ON i.id = n.indicator_id
             WHERE n.id IN ({$marks})", $ids) as $x) {
            $refs[$x->id] = $x;
        }

        return array_map(function (array $r) use ($refs) {
            $ref = $refs[$r['id']];

            return [
                'id' => $r['id'],
                'product' => ['id' => $r['product_id'], 'name' => $ref->product_name],
                'indicator' => ['id' => $r['indicator_id'], 'name' => $ref->indicator_name, 'unit' => $ref->indicator_unit],
                'maxValue' => $r['max_value'],
                'createdAt' => Iso::fromPg($r['created_at']), 'updatedAt' => Iso::fromPg($r['updated_at']),
            ];
        }, $rows);
    }

    /**
     * A row by id, optionally locked: `update` — FOR NO KEY UPDATE (a change that keeps the key does not block the
     * foreign-key checks of other tables, P23); `delete` — FOR UPDATE (a hard delete).
     *
     * @return array<string, mixed>|null
     */
    public static function select(string $name, string $id, ?string $lock = null): ?array
    {
        $mode = match ($lock) {
            'delete' => ' FOR UPDATE',
            'update' => ' FOR NO KEY UPDATE',
            default => '',
        };
        $r = DB::selectOne("SELECT * FROM {$name} WHERE id = ?{$mode}", [$id]);

        return $r === null ? null : (array) $r;
    }

    /**
     * @param  array<string, string|int|null>  $cols
     * @return array<string, mixed>
     */
    public static function insert(string $name, array $cols): array
    {
        $keys = array_keys($cols);
        $marks = implode(', ', array_fill(0, count($keys), '?'));

        return (array) DB::selectOne('INSERT INTO '.$name.' ('.implode(', ', $keys).") VALUES ({$marks}) RETURNING *", array_values($cols));
    }

    /**
     * Writes $cols (plus `updated_at = now()`, except regions — no timestamps; `restore` clears `deleted_at`).
     *
     * @param  array<string, string|int|null>  $cols
     * @return array<string, mixed>
     */
    public static function update(string $name, string $id, array $cols, bool $restore = false): array
    {
        $sets = array_map(fn (string $k) => "{$k} = ?", array_keys($cols));
        if ($name !== 'regions') {
            $sets[] = 'updated_at = now()';
        }
        if ($restore) {
            $sets[] = 'deleted_at = NULL';
        }

        return (array) DB::selectOne("UPDATE {$name} SET ".implode(', ', $sets).' WHERE id = ? RETURNING *', [...array_values($cols), $id]);
    }

    /**
     * Whether the row already holds these values (decimals compared numerically — `5` = `5.00`, R59).
     *
     * @param  array<string, mixed>  $row
     * @param  array<string, string|int|null>  $cols
     */
    public static function sameValues(array $row, array $cols): bool
    {
        foreach ($cols as $k => $v) {
            $cur = $row[$k] ?? null;
            if (isset(self::DECIMAL_COLUMNS[$k]) && $cur !== null && $v !== null) {
                if (Decimal::compare((string) $cur, (string) $v) !== 0) {
                    return false;
                }

                continue;
            }
            if ($cur !== $v) {
                return false;
            }
        }

        return true;
    }
}
