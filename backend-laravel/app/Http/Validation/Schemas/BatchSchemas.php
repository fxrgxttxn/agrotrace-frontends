<?php

namespace App\Http\Validation\Schemas;

use App\Http\Validation\Body;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\Z;

/** packages/validation/src/batches.ts, one to one (BatchCreate, QrRequest). */
final class BatchSchemas
{
    public static function batchCreate(): ObjectS
    {
        return Z::object([
            'fieldId' => Z::uuid(),
            'productId' => Z::uuid(),
            'massKg' => Z::massKg(),
            'harvestedAt' => Z::isoDateTime(),
        ]);
    }

    /** The body is optional at the operation level; when sent it must be `{}`. */
    public static function qrRequest(): ObjectS
    {
        return Z::object([]);
    }

    /**
     * BatchCreate with the wire mass check (`massKg` exactly three decimals, Express parseBody `['massKg']`).
     *
     * @return array{fieldId: string, productId: string, massKg: string, harvestedAt: string}
     */
    public static function parseCreate(mixed $body): array
    {
        return Body::parse(self::batchCreate(), $body, ['massKg']);
    }
}
