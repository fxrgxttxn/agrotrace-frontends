<?php

namespace App\Actions\Dictionaries;

use App\Http\Multipart\Upload;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\AdminSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\SlotHolder;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Files\Files;
use App\Infrastructure\Images\Images;
use App\Queries\PublicCache;
use App\Security\Principal;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;

/**
 * Dictionaries (contracts/openapi/paths/dictionaries.yaml, FR-ADM-02; R51, R54/D29, R82; Express dictionaries/
 * service.ts) and the public regions list (public.yaml#listPublicRegions): reading for every authenticated role,
 * writes and product photos for ADMIN. Layout, views and row writes — DictionaryStore; the import — Import.
 */
final class DictionariesActions
{
    public const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

    /**
     * The body of $name (DictionaryInput → the schema of that dictionary) as DB columns.
     *
     * @return array<string, string|int|null>
     */
    public static function parseInput(string $name, mixed $body): array
    {
        switch ($name) {
            case 'products':
                $v = AdminSchemas::product()->parse($body);

                // PUT replaces the whole entry: an absent mercuryCode is null (NullableMercuryCode).
                return ['name' => $v['name'], 'category' => $v['category'], 'loss_norm_percent' => $v['lossNormPercent'], 'mercury_code' => $v['mercuryCode'] ?? null];
            case 'substances':
                $v = AdminSchemas::substance()->parse($body);

                return ['name' => $v['name'], 'type' => $v['type'], 'waiting_period_days' => (int) $v['waitingPeriodDays']];
            case 'indicators':
                $v = AdminSchemas::indicator()->parse($body);

                return ['name' => $v['name'], 'unit' => $v['unit']];
            case 'norms':
                $v = AdminSchemas::norm()->parse($body);

                return ['product_id' => strtolower($v['productId']), 'indicator_id' => strtolower($v['indicatorId']), 'max_value' => $v['maxValue']];
            default:
                $v = AdminSchemas::region()->parse($body);

                return ['code' => $v['code'], 'name' => $v['name']];
        }
    }

    /**
     * listDictionary — filters per dictionary; a filter that does not apply or is not allowed → 400 (R51).
     *
     * @return array<string, mixed>
     */
    public static function list(Principal $p, string $name, QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(['name'], 'name,asc');
        $text = $q->q();
        $category = $type = $productId = $indicatorId = null;
        $includeDeleted = false;
        if ($name === 'products') {
            $category = $q->enum('category', AdminSchemas::CATEGORIES);
        } else {
            $q->notAllowed('category');
        }
        if ($name === 'substances') {
            $type = $q->enum('type', AdminSchemas::SUBSTANCE_TYPES);
        } else {
            $q->notAllowed('type');
        }
        if ($name === 'norms') {
            $productId = $q->uuid('productId');
            $indicatorId = $q->uuid('indicatorId');
        } else {
            $q->notAllowed('productId');
            $q->notAllowed('indicatorId');
        }
        if ($p->isAdmin() && DictionaryStore::SOFT_DELETE[$name]) {
            $includeDeleted = $q->bool('includeDeleted') ?? false;
        } else {
            $q->notAllowed('includeDeleted');
        }
        $q->done();

        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $conds = ['TRUE'];
        $bindings = [];
        $from = "{$name} t";
        $order = "t.name COLLATE \"C\" {$dir}";
        if (DictionaryStore::SOFT_DELETE[$name] && ! $includeDeleted) {
            $conds[] = 't.deleted_at IS NULL';
        }
        if ($category !== null) {
            $conds[] = 't.category = ?';
            $bindings[] = $category;
        }
        if ($type !== null) {
            $conds[] = 't.type = ?';
            $bindings[] = $type;
        }
        if ($name === 'norms') {
            $from = 'norms t JOIN products p ON p.id = t.product_id JOIN indicators i ON i.id = t.indicator_id';
            $order = "p.name COLLATE \"C\" {$dir}, i.name COLLATE \"C\" {$dir}";
            if ($productId !== null) {
                $conds[] = 't.product_id = ?';
                $bindings[] = $productId;
            }
            if ($indicatorId !== null) {
                $conds[] = 't.indicator_id = ?';
                $bindings[] = $indicatorId;
            }
        }
        if ($text !== null) {
            // Substring without case; `%`, `_`, `\` are ordinary characters (no LIKE).
            $has = fn (string $col) => "position(lower(?) in lower({$col})) > 0";
            if ($name === 'norms') {
                $conds[] = '('.$has('p.name').' OR '.$has('i.name').')';
                array_push($bindings, $text, $text);
            } elseif ($name === 'regions') {
                $conds[] = '('.$has('t.name').' OR '.$has('t.code').')';
                array_push($bindings, $text, $text);
            } else {
                $conds[] = $has('t.name');
                $bindings[] = $text;
            }
        }
        $where = implode(' AND ', $conds);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM {$from} WHERE {$where}", $bindings)->total;
        $rows = DB::select("SELECT t.* FROM {$from} WHERE {$where} ORDER BY {$order}, t.id::text COLLATE \"C\" LIMIT ? OFFSET ?",
            [...$bindings, $size, ($page - 1) * $size]);

        return [
            'items' => DictionaryStore::views($name, array_map(fn ($r) => (array) $r, $rows)),
            'page' => $page,
            'size' => $size,
            'total' => $total,
        ];
    }

    /**
     * norms: productId/indicatorId must be non-deleted rows → 400 `validation.notFound` on each; locked FOR SHARE (a
     * parallel soft delete of the product or indicator waits for this norm, P23).
     *
     * @param  array<string, string|int|null>  $cols
     */
    private static function checkNormRefs(array $cols): void
    {
        $errors = [];
        if (DB::selectOne('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL FOR SHARE', [$cols['product_id']]) === null) {
            $errors['productId'] = ['validation.notFound'];
        }
        if (DB::selectOne('SELECT id FROM indicators WHERE id = ? AND deleted_at IS NULL FOR SHARE', [$cols['indicator_id']]) === null) {
            $errors['indicatorId'] = ['validation.notFound'];
        }
        if ($errors !== []) {
            throw Problem::validation($errors);
        }
    }

    /**
     * The row holding the unique key of $cols other than $exceptId (all rows, soft-deleted included), locked.
     *
     * @param  array<string, string|int|null>  $cols
     * @return array<string, mixed>|null
     */
    private static function keyHolder(string $name, array $cols, ?string $exceptId = null): ?array
    {
        [$where, $bindings] = match ($name) {
            'norms' => ['product_id = ? AND indicator_id = ?', [$cols['product_id'], $cols['indicator_id']]],
            'regions' => ['code = ?', [$cols['code']]],
            default => ['name = ?', [$cols['name']]],
        };
        if ($exceptId !== null) {
            $where .= ' AND id <> ?';
            $bindings[] = $exceptId;
        }
        $r = DB::selectOne("SELECT * FROM {$name} WHERE {$where} FOR NO KEY UPDATE", $bindings);

        return $r === null ? null : (array) $r;
    }

    private static function duplicate(string $name): Problem
    {
        return Problem::validation([match ($name) {
            'norms' => 'indicatorId',
            'regions' => 'code',
            default => 'name',
        } => ['validation.duplicate']]);
    }

    /**
     * createDictionaryEntry — order: body → norms references (notFound) → uniqueness (duplicate). A name held by a
     * soft-deleted row restores that row with the body's values (201 with its id).
     *
     * @return array<string, mixed>
     */
    public static function create(Principal $p, string $name, mixed $body): array
    {
        $cols = self::parseInput($name, $body);
        $row = Tx::run(function () use ($p, $name, $cols): array {
            DictionaryStore::lock($name);
            if ($name === 'norms') {
                self::checkNormRefs($cols);
            }
            $held = self::keyHolder($name, $cols);
            $before = null;
            if ($held !== null && ! (DictionaryStore::isNamed($name) && $held['deleted_at'] !== null)) {
                throw self::duplicate($name);
            }
            if ($held !== null) {
                $before = DictionaryStore::auditView($name, $held);
                $after = DictionaryStore::update($name, $held['id'], $cols, true);
            } else {
                $after = DictionaryStore::insert($name, $cols);
            }
            AuditLog::write($p->userId, 'createDictionaryEntry', DictionaryStore::ENTITY_TYPE[$name], $after['id'],
                AuditLog::diff($before, DictionaryStore::auditView($name, $after)));

            return $after;
        });

        return DictionaryStore::views($name, [$row])[0];
    }

    /**
     * updateDictionaryEntry — order: body → 404 (missing or soft-deleted) → norms references → uniqueness against
     * every other row. Nothing changed → no write, no audit row (D5). A product rename drops its batches' pages.
     *
     * @return array<string, mixed>
     */
    public static function update(Principal $p, string $name, string $id, mixed $body): array
    {
        $cols = self::parseInput($name, $body);
        [$row, $codes] = Tx::run(function () use ($p, $name, $id, $cols): array {
            DictionaryStore::lock($name);
            $current = DictionaryStore::select($name, $id, 'update');
            if ($current === null || (DictionaryStore::SOFT_DELETE[$name] && $current['deleted_at'] !== null)) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            if ($name === 'norms') {
                self::checkNormRefs($cols);
            }
            if (self::keyHolder($name, $cols, $id) !== null) {
                throw self::duplicate($name);
            }
            if (DictionaryStore::sameValues($current, $cols)) {
                return [$current, []];
            }
            $after = DictionaryStore::update($name, $id, $cols);
            $diff = AuditLog::diff(DictionaryStore::auditView($name, $current), DictionaryStore::auditView($name, $after));
            AuditLog::write($p->userId, 'updateDictionaryEntry', DictionaryStore::ENTITY_TYPE[$name], $id, $diff);
            $codes = $name === 'products' && isset($diff['name']) ? PublicCache::productPageCodes([$id]) : [];

            return [$after, $codes];
        });
        PublicCache::dropCodes($codes);

        return DictionaryStore::views($name, [$row])[0];
    }

    /**
     * deleteDictionaryEntry — soft for products/substances/indicators, hard for norms and regions; a region that an
     * organization or a field (soft-deleted included) refers to → 409 REFERENCE_IN_USE {usedBy}.
     */
    public static function remove(Principal $p, string $name, string $id): void
    {
        Tx::run(function () use ($p, $name, $id): void {
            DictionaryStore::lock($name);
            $soft = DictionaryStore::SOFT_DELETE[$name];
            $current = DictionaryStore::select($name, $id, $soft ? 'update' : 'delete');
            if ($current === null || ($soft && $current['deleted_at'] !== null)) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            if ($soft) {
                $now = Tx::now();
                DB::update("UPDATE {$name} SET deleted_at = ?::timestamptz WHERE id = ?", [$now, $id]);
                $diff = ['deletedAt' => [null, Iso::fromPg($now)]];
            } else {
                if ($name === 'regions') {
                    $used = DB::selectOne('SELECT EXISTS (SELECT 1 FROM organizations WHERE region_id = ?) AS orgs,
                        EXISTS (SELECT 1 FROM fields WHERE region_id = ?) AS fields', [$id, $id]);
                    $usedBy = [...($used->orgs ? ['organizations'] : []), ...($used->fields ? ['fields'] : [])];
                    if ($usedBy !== []) {
                        throw new Problem(409, ProblemCode::REFERENCE_IN_USE, params: ['usedBy' => $usedBy]);
                    }
                }
                DB::delete("DELETE FROM {$name} WHERE id = ?", [$id]);
                $diff = [];
                foreach (DictionaryStore::auditView($name, $current) as $k => $v) {
                    if ($v !== null) {
                        $diff[$k] = [$v, null];
                    }
                }
            }
            AuditLog::write($p->userId, 'deleteDictionaryEntry', DictionaryStore::ENTITY_TYPE[$name], $id, $diff);
        });
    }

    /**
     * uploadProductImage — after the form (400) and the size (413): 404 for a missing or soft-deleted product, then the
     * type (415, JPEG/PNG/WebP by signature). The previous photo is soft-deleted; the product's public pages are
     * dropped (R82). The existence check's slot is given back before the image work and MinIO (P61).
     *
     * @return array<string, mixed>
     */
    public static function uploadImage(Principal $p, string $id, Upload $upload): array
    {
        if (DB::selectOne('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL', [$id]) === null) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }
        SlotHolder::release();
        $file = Files::prepare($upload, 'PRODUCT_IMAGE', $p->userId, Images::RASTER);
        Files::store($file);
        [$row, $codes] = Tx::run(function () use ($p, $id, $file): array {
            $current = DictionaryStore::select('products', $id, 'update');
            if ($current === null || $current['deleted_at'] !== null) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            $now = Tx::now();
            Files::insert($file);
            $after = DictionaryStore::update('products', $id, ['image_file_id' => $file->id()]);
            AuditLog::write($p->userId, 'uploadProductImage', 'file', $file->id(), AuditLog::diff(null, Files::auditView($file)));
            AuditLog::write($p->userId, 'uploadProductImage', 'product', $id, ['imageFileId' => [$current['image_file_id'], $file->id()]]);
            $old = $current['image_file_id'];
            if (Files::softDelete($old, $now)) {
                AuditLog::write($p->userId, 'uploadProductImage', 'file', $old, ['deletedAt' => [null, Iso::fromPg($now)]]);
            }

            return [$after, PublicCache::productPageCodes([$id])];
        });
        PublicCache::dropCodes($codes);

        return DictionaryStore::views('products', [$row])[0];
    }

    /**
     * listPublicRegions — every region by name (code points), then code; no paging.
     *
     * @return list<array{code: string, name: string}>
     */
    public static function publicRegions(): array
    {
        return array_map(fn ($r) => ['code' => $r->code, 'name' => $r->name],
            DB::select('SELECT code, name FROM regions ORDER BY name COLLATE "C", code COLLATE "C"'));
    }
}
