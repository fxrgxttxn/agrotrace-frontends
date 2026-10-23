<?php

namespace App\Http\Validation;

use App\Http\Problem\Problem;
use App\Http\Validation\Z\Schema;
use stdClass;

/**
 * Request bodies by the shared schemas (Express http/body.ts `parseBody`). Where a form-level schema is looser than
 * the wire format the wire check adds the contract's key: a mass (`Mass`/`PositiveMass`) is exactly three decimals —
 * "the server does not normalize other forms" — so a string mass without them is `validation.mass.format` at its path
 * (unless the schema already reported that path). Errors of the request's other parameters (`If-Match`) join the same
 * 400 (P36). Deferred duplicates (`$deferDuplicates`: array fields whose `validation.duplicate` the operation reports
 * at its own later step, P36) are dropped from the schema-stage errors; when only they failed, the raw body is
 * returned as is.
 */
final class Body
{
    /** Contract `Mass`/`PositiveMass` on the wire: exactly three decimals (a JavaScript pattern, run through Ecma). */
    public const WIRE_MASS = '^\d{1,9}\.\d{3}$';

    /**
     * @param  list<string|array{0: string, 1: string}>  $masses  a top-level field, or [arrayField, itemField]
     * @param  array<string, list<string>>  $extraErrors
     * @param  list<string>  $deferDuplicates
     */
    public static function parse(Schema $schema, mixed $raw, array $masses = [], array $extraErrors = [], array $deferDuplicates = []): mixed
    {
        $r = $schema->safeParse($raw);
        $errors = $r['ok'] ? [] : $r['issues']->fieldErrors();
        if (! $r['ok'] && $deferDuplicates !== []) {
            foreach ($errors as $path => $keys) {
                if (! self::isItemField((string) $path, $deferDuplicates)) {
                    continue;
                }
                $rest = array_values(array_filter($keys, fn (string $k) => $k !== 'validation.duplicate'));
                if ($rest !== []) {
                    $errors[$path] = $rest;
                } else {
                    unset($errors[$path]);
                }
            }
        }
        if ($raw instanceof stdClass) {
            $wire = Ecma::compile(self::WIRE_MASS);
            foreach ($masses as $m) {
                if (is_string($m)) {
                    $v = $raw->{$m} ?? null;
                    if (is_string($v) && ! Ecma::test($wire, $v)) {
                        $errors[$m] ??= ['validation.mass.format'];
                    }

                    continue;
                }
                [$array, $field] = $m;
                $list = $raw->{$array} ?? null;
                if (! is_array($list)) {
                    continue;
                }
                foreach ($list as $i => $item) {
                    $v = $item instanceof stdClass ? ($item->{$field} ?? null) : null;
                    if (is_string($v) && ! Ecma::test($wire, $v)) {
                        $errors["{$array}[{$i}].{$field}"] ??= ['validation.mass.format'];
                    }
                }
            }
        }
        foreach ($extraErrors as $path => $keys) {
            $errors[$path] = [...($errors[$path] ?? []), ...$keys];
        }
        if ($errors !== []) {
            throw Problem::validation($errors);
        }

        return $r['ok'] ? $r['value'] : $raw;
    }

    /**
     * Whether $path is `<array>[<digits>].<letters>` for one of $arrays (Express's `^${a}\[\d+\]\.[A-Za-z]+$`).
     *
     * @param  list<string>  $arrays
     */
    private static function isItemField(string $path, array $arrays): bool
    {
        foreach ($arrays as $a) {
            if (! str_starts_with($path, "{$a}[")) {
                continue;
            }
            $rest = substr($path, strlen($a) + 1);
            $close = strpos($rest, '].');
            if ($close === false || $close === 0 || ! ctype_digit(substr($rest, 0, $close))) {
                continue;
            }
            $name = substr($rest, $close + 2);
            if ($name !== '' && ctype_alpha($name)) {
                return true;
            }
        }

        return false;
    }
}
