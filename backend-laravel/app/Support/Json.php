<?php

namespace App\Support;

use stdClass;

/**
 * JSON with the semantics of the other implementations (L9, Review Focus 8):
 * - objects stay objects: `decode` yields stdClass for every JSON object (so `{}` never comes back as `[]`), `obj`
 *   builds one from an associative array; an empty PHP array always encodes as `[]`;
 * - numbers as JavaScript prints them: `1.0` encodes as `1`, no zero fraction is kept;
 * - text as JSON.stringify writes it: `/`, non-ASCII and U+2028/U+2029 unescaped.
 */
final class Json
{
    public const ENCODE_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS
        | JSON_THROW_ON_ERROR;

    public static function encode(mixed $value): string
    {
        return json_encode($value, self::ENCODE_FLAGS);
    }

    /** @throws \JsonException on malformed JSON */
    public static function decode(string $json): mixed
    {
        return json_decode($json, false, 512, JSON_THROW_ON_ERROR);
    }

    /**
     * An associative array as a JSON object, recursively for nested associative arrays (lists stay lists; a nested
     * empty array stays `[]`, pass `new stdClass` for an empty nested object).
     *
     * @param  array<mixed>  $fields
     */
    public static function obj(array $fields): stdClass
    {
        $out = new stdClass;
        foreach ($fields as $k => $v) {
            $out->{(string) $k} = is_array($v) && $v !== [] && ! array_is_list($v) ? self::obj($v) : $v;
        }

        return $out;
    }
}
