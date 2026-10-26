<?php

namespace App\Http\Validation\Schemas;

use App\Http\Validation\Body;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\Z;

/**
 * packages/validation/src/recalls.ts, one to one (RecallCreate, RecallTaskConfirm). confirmRecallTask's body is
 * optional (none → `{}`, Express `body ?? {}`); its `If-Match` errors join the same 400 (P36).
 */
final class RecallSchemas
{
    public static function create(): ObjectS
    {
        return Z::object([
            'sourceBatchId' => Z::uuid(),
            'reason' => Z::codePointString(1, 1000, '\S'),
            'blockUpstream' => Z::boolean(),
        ]);
    }

    public static function confirm(): ObjectS
    {
        return Z::object([]);
    }

    /** @return array{sourceBatchId: string, reason: string, blockUpstream: bool} */
    public static function parseCreate(mixed $body): array
    {
        return Body::parse(self::create(), $body);
    }

    /** @param  array<string, list<string>>  $ifMatchErrors */
    public static function parseConfirm(mixed $body, array $ifMatchErrors): void
    {
        Body::parse(self::confirm(), $body, [], $ifMatchErrors);
    }
}
