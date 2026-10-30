<?php

namespace App\Http\Validation\Schemas;

use App\Http\Validation\Z\UnionS;
use App\Http\Validation\Z\Z;

/** packages/validation/src/profile.ts MarkReadRequestSchema, one to one. */
final class NotificationSchemas
{
    /** `{ids: uuid[1..100], unique}` or `{upToSeq: int ≥ 1}`, both strict (z.union: the first dirty option's issues). */
    public static function markRead(): UnionS
    {
        return Z::union([
            Z::object([
                'ids' => Z::array(Z::uuid())->min(1)->max(100)
                    ->refine(fn (array $a) => Z::unique($a), 'validation.duplicate'),
            ]),
            Z::object(['upToSeq' => Z::number()->int()->min(1)]),
        ]);
    }
}
