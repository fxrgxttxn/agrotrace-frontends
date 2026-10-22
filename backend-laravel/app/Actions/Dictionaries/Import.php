<?php

namespace App\Actions\Dictionaries;

use App\Domain\Decimal;
use App\Http\Problem\Problem;
use App\Http\Validation\Ecma;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Import\Cell;
use App\Infrastructure\Import\Sheet;
use App\Queries\PublicCache;
use App\Support\Json;
use Illuminate\Support\Facades\DB;

/**
 * importDictionary (dictionaries.yaml, FR-ANL-05, R54/D30, R58, R59; Express dictionaries/import.ts): the header check
 * → row checks in file order → one transaction that creates, updates (restoring soft-deleted rows) or leaves rows as
 * they are, with an audit row per created or updated row → `ImportReport`.
 *
 * Row rules: a row with another number of cells than the header → `{column: null, validation.import.columns}`; values
 * are never trimmed (R36) and follow `DictionaryInput` except the import's own number formats (`lossNormPercent`
 * `^\d{1,3}(\.\d{1,2})?$` ≤ 100, `waitingPeriodDays` `^\d{1,4}$` ≤ 3650, `maxValue` Decimal); `product`/`indicator`
 * name a non-deleted row exactly. The key (`name`, `code`, the `product`+`indicator` pair) belongs to the first row in
 * file order that carries it — even a row with value errors; every later row with the same key → `validation.duplicate`
 * at the key column, after that column's value errors (D7). Rows with errors are skipped. `mercuryCode` is never set.
 */
final class Import
{
    public const MAX_BYTES = 5 * 1024 * 1024;

    public const COLUMNS = [
        'products' => ['name', 'category', 'lossNormPercent'],
        'substances' => ['name', 'type', 'waitingPeriodDays'],
        'indicators' => ['name', 'unit'],
        'norms' => ['product', 'indicator', 'maxValue'],
        'regions' => ['code', 'name'],
    ];

    private const KEY_COLUMN = ['products' => 'name', 'substances' => 'name', 'indicators' => 'name', 'norms' => 'indicator', 'regions' => 'code'];

    /**
     * @return array{created: int, updated: int, unchanged: int, errors: list<array{row: int, column: ?string, message: string}>}
     */
    public static function apply(string $name, Sheet $sheet, string $actorId): array
    {
        $columns = self::COLUMNS[$name];
        $header = $sheet->header;
        if ($header !== $columns) {
            throw Problem::validation(['file' => ['validation.import.header']]);
        }
        $rules = self::rules($name);

        [$report, $codes] = Tx::run(function () use ($name, $sheet, $columns, $rules, $actorId): array {
            DictionaryStore::lock($name);
            $report = ['created' => 0, 'updated' => 0, 'unchanged' => 0, 'errors' => []];
            [$products, $indicators] = $name === 'norms' ? self::referenceMaps() : [[], []];
            $keys = [];
            $valid = [];
            $width = count($columns);
            $keyCol = array_search(self::KEY_COLUMN[$name], $columns, true);

            foreach ($sheet->rows as $row) {
                $cells = $row['cells'];
                if ($cells !== null && $sheet->padShort && count($cells) < $width) {
                    $cells = array_pad($cells, $width, '');
                }
                if ($cells === null || count($cells) !== $width) {
                    $report['errors'][] = ['row' => $row['number'], 'column' => null, 'message' => 'validation.import.columns'];

                    continue;
                }
                $errs = [];
                foreach ($cells as $col => $cell) {
                    $message = $cell instanceof Cell ? $cell->message() : $rules[$col]($cell);
                    if ($message !== null) {
                        $errs[] = ['col' => $col, 'message' => $message];
                    }
                }
                $hasError = fn (int $col) => array_filter($errs, fn ($e) => $e['col'] === $col) !== [];
                if ($name === 'norms') {
                    [$product, $indicator] = $cells;
                    if (is_string($product) && $product !== '' && ! $hasError(0) && ! isset($products[$product])) {
                        $errs[] = ['col' => 0, 'message' => 'validation.notFound'];
                    }
                    if (is_string($indicator) && $indicator !== '' && ! $hasError(1) && ! isset($indicators[$indicator])) {
                        $errs[] = ['col' => 1, 'message' => 'validation.notFound'];
                    }
                }
                // The key belongs to the first row that carries it (non-empty text key cells), errors or not (R59).
                $keyCells = $name === 'norms' ? [$cells[0], $cells[1]] : [$cells[0]];
                if (array_filter($keyCells, fn ($k) => ! is_string($k) || $k === '') === []) {
                    $key = implode("\0", $keyCells);
                    if (isset($keys[$key])) {
                        $errs[] = ['col' => $keyCol, 'message' => 'validation.duplicate'];
                    } else {
                        $keys[$key] = true;
                    }
                }
                if ($errs !== []) {
                    usort($errs, fn ($a, $b) => $a['col'] <=> $b['col']);
                    foreach ($errs as $e) {
                        $report['errors'][] = ['row' => $row['number'], 'column' => $columns[$e['col']], 'message' => $e['message']];
                    }

                    continue;
                }
                /** @var list<string> $cells */
                $cols = self::columnsOf($name, $cells, $products, $indicators);
                $valid[] = ['key' => self::rowKey($name, $cols), 'cols' => $cols];
            }

            $existing = self::existingRows($name, $valid);
            $changedProducts = [];
            foreach ($valid as $v) {
                $current = $existing[$v['key']] ?? null;
                $before = null;
                if ($current === null) {
                    $after = DictionaryStore::insert($name, $v['cols']);
                    $report['created']++;
                } else {
                    $restore = DictionaryStore::isNamed($name) && $current['deleted_at'] !== null;
                    if (! $restore && DictionaryStore::sameValues($current, $v['cols'])) {
                        $report['unchanged']++;

                        continue;
                    }
                    $before = DictionaryStore::auditView($name, $current);
                    $after = DictionaryStore::update($name, $current['id'], $v['cols'], $restore);
                    $report['updated']++;
                    if ($name === 'products') {
                        $changedProducts[] = $current['id'];
                    }
                }
                AuditLog::write($actorId, 'importDictionary', DictionaryStore::ENTITY_TYPE[$name], $after['id'],
                    AuditLog::diff($before, DictionaryStore::auditView($name, $after)));
            }

            return [$report, PublicCache::productPageCodes($changedProducts)];
        });
        PublicCache::dropCodes($codes);

        return $report;
    }

    /**
     * The value rule of every column of $name: the error key of a cell text, or null.
     *
     * @return list<callable(string): ?string>
     */
    private static function rules(string $name): array
    {
        $nonSpace = Ecma::compile('\S');
        $text = fn (int $max) => function (string $v) use ($max, $nonSpace): ?string {
            if ($v === '') {
                return 'validation.required';
            }
            $bytes = strlen($v);
            if ($bytes > 4 * $max || ($bytes > $max && mb_strlen($v, 'UTF-8') > $max)) {
                return 'validation.maxLength';
            }

            return Ecma::test($nonSpace, $v) ? null : 'validation.pattern';
        };
        $oneOf = fn (array $values) => fn (string $v): ?string => $v === '' ? 'validation.required' : (in_array($v, $values, true) ? null : 'validation.enum');
        $number = function (string $pattern, string $max): callable {
            $compiled = Ecma::compile($pattern);

            return fn (string $v): ?string => $v === '' ? 'validation.required'
                : (! Ecma::test($compiled, $v) ? 'validation.pattern' : (Decimal::compare($v, $max) > 0 ? 'validation.max' : null));
        };
        $matching = function (string $pattern): callable {
            $compiled = Ecma::compile($pattern);

            return fn (string $v): ?string => $v === '' ? 'validation.required' : (Ecma::test($compiled, $v) ? null : 'validation.pattern');
        };

        return match ($name) {
            'products' => [$text(160), $oneOf(['GRAIN', 'VEGETABLE', 'FRUIT', 'DAIRY', 'MEAT', 'OILSEED', 'PROCESSED']), $number('^\d{1,3}(\.\d{1,2})?$', '100')],
            'substances' => [$text(160), $oneOf(['PESTICIDE', 'FERTILIZER']), $number('^\d{1,4}$', '3650')],
            'indicators' => [$text(160), $text(24)],
            // product / indicator: exact names, looked up separately.
            'norms' => [$text(160), $text(160), $matching('^\d{1,8}(\.\d{1,6})?$')],
            default => [$matching('^[0-9A-Z-]{1,8}$'), $text(120)],
        };
    }

    /**
     * Columns of a checked row.
     *
     * @param  list<string>  $v
     * @param  array<string, string>  $products
     * @param  array<string, string>  $indicators
     * @return array<string, string|int>
     */
    private static function columnsOf(string $name, array $v, array $products, array $indicators): array
    {
        return match ($name) {
            'products' => ['name' => $v[0], 'category' => $v[1], 'loss_norm_percent' => $v[2]],
            'substances' => ['name' => $v[0], 'type' => $v[1], 'waiting_period_days' => (int) $v[2]],
            'indicators' => ['name' => $v[0], 'unit' => $v[1]],
            'norms' => ['product_id' => $products[$v[0]], 'indicator_id' => $indicators[$v[1]], 'max_value' => $v[2]],
            default => ['code' => $v[0], 'name' => $v[1]],
        };
    }

    /** @param  array<string, mixed>  $cols */
    private static function rowKey(string $name, array $cols): string
    {
        return match ($name) {
            'norms' => $cols['product_id'].'|'.$cols['indicator_id'],
            'regions' => (string) $cols['code'],
            default => (string) $cols['name'],
        };
    }

    /**
     * The existing rows (soft-deleted included) holding the keys of $rows, locked, by key.
     *
     * @param  list<array{key: string, cols: array<string, string|int>}>  $rows
     * @return array<string, array<string, mixed>>
     */
    private static function existingRows(string $name, array $rows): array
    {
        $out = [];
        foreach (array_chunk($rows, 1000) as $chunk) {
            $cols = array_column($chunk, 'cols');
            if ($name === 'norms') {
                $found = DB::select('SELECT n.* FROM norms n
                      JOIN jsonb_to_recordset(?::jsonb) AS k(product_id uuid, indicator_id uuid)
                        ON k.product_id = n.product_id AND k.indicator_id = n.indicator_id
                     FOR NO KEY UPDATE OF n', [Json::encode(array_map(fn ($c) => ['product_id' => $c['product_id'], 'indicator_id' => $c['indicator_id']], $cols))]);
            } else {
                $column = $name === 'regions' ? 'code' : 'name';
                $found = DB::select("SELECT * FROM {$name} WHERE {$column} IN (SELECT jsonb_array_elements_text(?::jsonb)) FOR NO KEY UPDATE",
                    [Json::encode(array_map(fn ($c) => (string) $c[$column], $cols))]);
            }
            foreach ($found as $row) {
                $row = (array) $row;
                $out[self::rowKey($name, $row)] = $row;
            }
        }

        return $out;
    }

    /**
     * Non-deleted products and indicators by exact name (norms import), FOR SHARE — no parallel soft delete (P23).
     *
     * @return array{0: array<string, string>, 1: array<string, string>}
     */
    private static function referenceMaps(): array
    {
        $map = function (string $table): array {
            $out = [];
            foreach (DB::select("SELECT id, name FROM {$table} WHERE deleted_at IS NULL FOR SHARE") as $r) {
                $out[$r->name] = $r->id;
            }

            return $out;
        };

        return [$map('products'), $map('indicators')];
    }
}
