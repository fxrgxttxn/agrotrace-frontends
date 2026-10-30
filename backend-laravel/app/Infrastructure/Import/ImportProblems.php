<?php

namespace App\Infrastructure\Import;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;

/** The problems of reading an import file (contract importDictionary). */
final class ImportProblems
{
    public const ALLOWED = ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

    /** A ZIP that is no readable workbook, a NUL byte → 415 `{allowed}`. */
    public static function unsupported(): Problem
    {
        return new Problem(415, ProblemCode::UNSUPPORTED_MEDIA_TYPE, params: ['allowed' => self::ALLOWED]);
    }

    /** A workbook over the P23–P28 limits, a full lane, the deadline → 415 `{allowed, reason: workbook-too-large}`. */
    public static function tooLarge(): Problem
    {
        return new Problem(415, ProblemCode::UNSUPPORTED_MEDIA_TYPE, params: ['allowed' => self::ALLOWED, 'reason' => 'workbook-too-large']);
    }

    public static function badFormat(): Problem
    {
        return Problem::validation(['file' => ['validation.import.format']]);
    }

    public static function tooManyRows(): Problem
    {
        return Problem::validation(['file' => ['validation.import.tooManyRows']]);
    }
}
