<?php

namespace App\Http\Query;

use App\Http\Problem\Problem;
use Illuminate\Http\Request;

/** Path parameters and the shared `variant` query parameter (components/parameters.yaml; Express http/params.ts). */
final class Params
{
    /** `IdPath` (uuid) → the id in lower case; otherwise 400 `errors.<name>: [validation.uuid]`. */
    public static function id(Request $request, string $name = 'id'): string
    {
        $v = $request->route($name);
        if (! is_string($v) || ! QueryReader::isUuid($v)) {
            throw Problem::validation([$name => ['validation.uuid']]);
        }

        return strtolower($v);
    }

    /** `ImageVariant` (96 | 480, default 480). */
    public static function variant(Request $request): int
    {
        $q = QueryReader::of($request);
        $v = $q->enum('variant', ['96', '480']);
        $q->done();

        return $v === '96' ? 96 : 480;
    }
}
