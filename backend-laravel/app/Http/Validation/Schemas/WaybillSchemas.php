<?php

namespace App\Http\Validation\Schemas;

use App\Http\Validation\Body;
use App\Http\Validation\Z\Effects;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\Z;
use App\Support\Json;

/**
 * packages/validation/src/waybills.ts, one to one (WaybillCreate, WaybillAccept, WaybillReject), plus the operations'
 * parse calls as Express makes them (waybills/service.ts): the wire mass check of the items, and a repeated `batchId`
 * deferred to the operation's own step (create: step 2 references; accept: step 6 `items.mismatch` — P36).
 */
final class WaybillSchemas
{
    public static function create(): ObjectS
    {
        return Z::object([
            'receiverOrgId' => Z::uuid(),
            'items' => self::items(Z::object([
                'batchId' => Z::uuid(),
                'massDeclaredKg' => Z::massKg(),
            ])),
        ]);
    }

    public static function accept(): ObjectS
    {
        return Z::object([
            'items' => self::items(Z::object([
                'batchId' => Z::uuid(),
                'massActualKg' => Z::massKg(),
                'discrepancyAct' => Z::codePointString(1, 2000, '\S')->optional(),
            ])),
        ]);
    }

    public static function reject(): ObjectS
    {
        return Z::object(['reason' => Z::codePointString(1, 500, '\S')]);
    }

    /**
     * @return array{receiverOrgId: string, items: list<array{batchId: string, massDeclaredKg: string}>}
     */
    public static function parseCreate(mixed $body): array
    {
        return self::plain(Body::parse(self::create(), $body, [['items', 'massDeclaredKg']], deferDuplicates: ['items']));
    }

    /**
     * @param  array<string, list<string>>  $ifMatchErrors
     * @return array{items: list<array{batchId: string, massActualKg: string, discrepancyAct?: string}>}
     */
    public static function parseAccept(mixed $body, array $ifMatchErrors): array
    {
        return self::plain(Body::parse(self::accept(), $body, [['items', 'massActualKg']], $ifMatchErrors, ['items']));
    }

    /**
     * @param  array<string, list<string>>  $ifMatchErrors
     * @return array{reason: string}
     */
    public static function parseReject(mixed $body, array $ifMatchErrors): array
    {
        return Body::parse(self::reject(), $body, [], $ifMatchErrors);
    }

    /**
     * The parsed value as arrays: when only a deferred repeat failed, Body::parse returns the raw (decoded) body —
     * valid in every other respect, masses already in the wire form.
     *
     * @return array<string, mixed>
     */
    private static function plain(mixed $v): array
    {
        return is_array($v) ? $v : json_decode(Json::encode($v), true, 512, JSON_THROW_ON_ERROR);
    }

    private static function items(ObjectS $item): Effects
    {
        return Z::array($item)->min(1)->max(100)->superRefine(Z::noDuplicate('batchId'));
    }
}
