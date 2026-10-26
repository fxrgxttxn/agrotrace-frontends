<?php

namespace App\Http\Validation\Schemas;

use App\Http\Problem\Problem;
use App\Http\Validation\Body;
use App\Http\Validation\Z\DiscriminatedS;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\Z;
use stdClass;

/**
 * packages/validation/src/complaints.ts, one to one (PublicComplaintRequest, ComplaintReviewRequest, the
 * discriminated ComplaintDecision), plus Express complaints/service.ts `decisionRules` (P42, P44): `labOrgId` with a
 * decision other than LAB_TEST and `blockUpstream` with one other than RECALL → `validation.notAllowed`; LAB_TEST
 * without `labOrgId` → `validation.required`; no `decision` → `validation.required`. They are reported in the same
 * 400 as the schema's errors and win per field (`{...errors, ...rules}`: a rule replaces a schema error in place, a
 * new key goes last).
 */
final class ComplaintSchemas
{
    public static function publicComplaint(): ObjectS
    {
        return Z::object([
            'text' => Z::codePointString(10, 2000, '\S'),
            'contact' => Z::codePointString(1, 255, '\S')->optional(),
            'altcha' => Z::codePointString(1, 4096),
        ]);
    }

    public static function review(): ObjectS
    {
        return Z::object([]);
    }

    public static function decision(): DiscriminatedS
    {
        $comment = Z::codePointString(1, 1000, '\S');

        return Z::discriminatedUnion('decision', [
            'REJECT' => Z::object(['decision' => Z::literal('REJECT'), 'comment' => $comment]),
            'LAB_TEST' => Z::object(['decision' => Z::literal('LAB_TEST'), 'comment' => $comment, 'labOrgId' => Z::uuid()]),
            'RECALL' => Z::object(['decision' => Z::literal('RECALL'), 'comment' => $comment, 'blockUpstream' => Z::boolean()->default(false)]),
        ]);
    }

    /**
     * createPublicComplaint: the body and the publicCode pattern ($codeErrors) in one 400.
     *
     * @param  array<string, list<string>>  $codeErrors
     * @return array{text: string, contact?: string, altcha: string}
     */
    public static function parsePublic(mixed $body, array $codeErrors): array
    {
        return Body::parse(self::publicComplaint(), $body, [], $codeErrors);
    }

    public static function parseReview(mixed $body): void
    {
        Body::parse(self::review(), $body);
    }

    /** @return array{decision: 'REJECT'|'LAB_TEST'|'RECALL', comment: string, labOrgId?: string, blockUpstream?: bool} */
    public static function parseDecision(mixed $body): array
    {
        $rules = self::decisionRules($body);
        try {
            $input = Body::parse(self::decision(), $body);
        } catch (Problem $p) {
            if ($p->errors === null) {
                throw $p;
            }
            $merged = $p->errors;
            foreach ($rules as $k => $v) {
                $merged[$k] = $v;
            }
            throw Problem::validation($merged);
        }
        if ($rules !== []) {
            throw Problem::validation($rules);
        }

        return $input;
    }

    /** @return array<string, list<string>> */
    public static function decisionRules(mixed $raw): array
    {
        $errors = [];
        if (! $raw instanceof stdClass) {
            return $errors;
        }
        $r = get_object_vars($raw);
        // P19: a missing discriminator is `required` (the discriminated union alone reports `enum`).
        if (! array_key_exists('decision', $r)) {
            $errors['decision'] = ['validation.required'];
        }
        $decision = $r['decision'] ?? null;
        if (! is_string($decision)) {
            return $errors;
        }
        if (array_key_exists('labOrgId', $r) && $decision !== 'LAB_TEST') {
            $errors['labOrgId'] = ['validation.notAllowed'];
        }
        if (array_key_exists('blockUpstream', $r) && $decision !== 'RECALL') {
            $errors['blockUpstream'] = ['validation.notAllowed'];
        }
        if ($decision === 'LAB_TEST' && ! array_key_exists('labOrgId', $r)) {
            $errors['labOrgId'] = ['validation.required'];
        }

        return $errors;
    }
}
