<?php

namespace App\Http\Validation\Schemas;

use App\Http\Validation\Body;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\Z;
use App\Support\Json;

/**
 * packages/validation/src/lab.ts, one to one (LabTestCreate, LabSampleRequest, LabResultsInput), plus the parse calls
 * of Express lab/service.ts: registerLabSample's body is optional (none → `{}`); a repeated `indicatorId` is step 5 of
 * submitLabResults (after 404/If-Match/status, P36), so it is deferred here. `If-Match` errors join the same 400.
 */
final class LabSchemas
{
    public static function create(): ObjectS
    {
        return Z::object(['batchId' => Z::uuid(), 'labOrgId' => Z::uuid()]);
    }

    public static function sample(): ObjectS
    {
        return Z::object([]);
    }

    public static function results(): ObjectS
    {
        return Z::object([
            'results' => Z::array(Z::object([
                'indicatorId' => Z::uuid(),
                'value' => Z::decimal(),
            ]))->min(1)->max(200)->superRefine(Z::noDuplicate('indicatorId')),
        ]);
    }

    /** @return array{batchId: string, labOrgId: string} */
    public static function parseCreate(mixed $body): array
    {
        return Body::parse(self::create(), $body);
    }

    /** @param  array<string, list<string>>  $ifMatchErrors */
    public static function parseSample(mixed $body, array $ifMatchErrors): void
    {
        Body::parse(self::sample(), $body, [], $ifMatchErrors);
    }

    /**
     * @param  array<string, list<string>>  $ifMatchErrors
     * @return array{results: list<array{indicatorId: string, value: string}>}
     */
    public static function parseResults(mixed $body, array $ifMatchErrors): array
    {
        $v = Body::parse(self::results(), $body, [], $ifMatchErrors, ['results']);

        // Only the deferred repeat failed: Body::parse returned the decoded body (valid in every other respect).
        return is_array($v) ? $v : json_decode(Json::encode($v), true, 512, JSON_THROW_ON_ERROR);
    }
}
