<?php

namespace App\Http\Validation\Schemas;

use App\Http\Validation\Body;
use App\Http\Validation\Ecma;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\StringS;
use App\Http\Validation\Z\Z;

/**
 * packages/validation/src/processing.ts (ProcessingRequest), plus Express's parse call (processing/service.ts): the wire
 * mass check of `inputs[i].massUsedKg` and `outputs[i].massKg`. A repeated input `batchId` is a step-1 schema error.
 *
 * One deliberate difference from Zod's `noDuplicate` (raw string compare): two VALID uuids that differ only in letter
 * case are the same batch, so the later one is `validation.duplicate` too — Express accepts them and fails on the
 * `batch_links` unique key with a 500 (Django Task 8 decision 1). Strings that are not uuids compare raw, so their 400
 * bodies stay identical to Express's (Django Task 8 review M1).
 */
final class ProcessingSchemas
{
    public static function request(): ObjectS
    {
        return Z::object([
            'inputs' => Z::array(Z::object([
                'batchId' => Z::uuid(),
                'massUsedKg' => Z::massKg(),
            ]))->min(1)->max(50)->superRefine(self::noDuplicateBatch()),
            'outputs' => Z::array(Z::object([
                'productId' => Z::uuid(),
                'massKg' => Z::massKg(),
            ]))->min(1)->max(20),
        ]);
    }

    /**
     * @return array{inputs: list<array{batchId: string, massUsedKg: string}>, outputs: list<array{productId: string, massKg: string}>}
     */
    public static function parse(mixed $body): array
    {
        return Body::parse(self::request(), $body, [['inputs', 'massUsedKg'], ['outputs', 'massKg']]);
    }

    /** Z::noDuplicate('batchId') with valid uuids compared case-insensitively. */
    private static function noDuplicateBatch(): callable
    {
        $uuid = Ecma::compile(StringS::UUID, 'i');

        return function (array $items, callable $add) use ($uuid): void {
            $seen = [];
            foreach ($items as $i => $item) {
                $v = is_array($item) ? ($item['batchId'] ?? null) : null;
                if (is_string($v) && Ecma::test($uuid, $v)) {
                    $v = strtolower($v);
                }
                if (in_array($v, $seen, true)) {
                    $add('validation.duplicate', [$i, 'batchId']);
                }
                $seen[] = $v;
            }
        };
    }
}
