<?php

namespace App\Http\Validation\Z;

use App\Http\Validation\Ecma;

/**
 * Factories and the shared primitives of packages/validation/src/common.ts, one to one (keys `validation.*`, patterns
 * verbatim, R36: never trimmed, lengths in code points by refinements).
 */
final class Z
{
    public static function string(): StringS
    {
        return new StringS;
    }

    public static function number(): NumberS
    {
        return new NumberS;
    }

    public static function boolean(): BooleanS
    {
        return new BooleanS;
    }

    /** @param  list<string>  $values */
    public static function enum(array $values): EnumS
    {
        return new EnumS($values);
    }

    public static function literal(string|int|bool $value): EnumS
    {
        return new EnumS([$value], true);
    }

    public static function array(Schema $element): ArrayS
    {
        return new ArrayS($element);
    }

    /**
     * `z.object(shape).strict()`.
     *
     * @param  array<string, Schema>  $shape
     */
    public static function object(array $shape): ObjectS
    {
        return new ObjectS($shape, true);
    }

    /** @param  list<Schema>  $options */
    public static function union(array $options): UnionS
    {
        return new UnionS($options);
    }

    /**
     * `z.discriminatedUnion(discriminator, options)`, the options by their discriminator value.
     *
     * @param  array<string, Schema>  $options
     */
    public static function discriminatedUnion(string $discriminator, array $options): DiscriminatedS
    {
        return new DiscriminatedS($discriminator, $options);
    }

    /** @param  list<Schema>  $items */
    public static function tuple(array $items): TupleS
    {
        return new TupleS($items);
    }

    // ── common.ts ────────────────────────────────────────────────────────────────────────────────────────────────

    /** `codePointString(min, max, pattern?)`: empty → required (min > 0), shorter → minLength, longer → maxLength. */
    public static function codePointString(int $min, int $max, ?string $jsPattern = null): Effects
    {
        $compiled = $jsPattern !== null ? Ecma::compile($jsPattern) : null;

        return self::string()
            ->refine(
                fn (string $s) => StringS::codePoints($s) >= $min,
                fn (string $s) => StringS::codePoints($s) === 0 ? 'validation.required' : 'validation.minLength',
            )
            ->refine(fn (string $s) => StringS::codePoints($s) <= $max, 'validation.maxLength')
            ->refine(fn (string $s) => $compiled === null || Ecma::test($compiled, $s), 'validation.pattern');
    }

    /** FNS INN checksum, 10 or 12 digits. */
    public static function isValidInn(string $s): bool
    {
        if (! Ecma::test(Ecma::compile('^\d{10}(\d{2})?$'), $s)) {
            return false;
        }
        $d = array_map('intval', str_split($s));
        $control = function (array $weights) use ($d): int {
            $sum = 0;
            foreach ($weights as $i => $w) {
                $sum += $w * $d[$i];
            }

            return ($sum % 11) % 10;
        };
        if (count($d) === 10) {
            return $control([2, 4, 10, 3, 5, 9, 4, 6, 8]) === $d[9];
        }

        return $control([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === $d[10] && $control([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === $d[11];
    }

    public static function inn(): Effects
    {
        return self::string()->regex('^\d{10}(\d{2})?$', 'validation.inn.format')
            ->refine(fn (string $s) => self::isValidInn($s), 'validation.inn.checksum');
    }

    public static function email(): Effects
    {
        return self::string()->min(1, 'validation.required')->email('validation.email')
            ->refine(fn (string $s) => StringS::codePoints($s) <= 254, 'validation.maxLength');
    }

    public static function password(): Effects
    {
        return self::string()->min(1, 'validation.required')
            ->refine(fn (string $s) => StringS::codePoints($s) >= 10, 'validation.password.min')
            ->refine(fn (string $s) => StringS::codePoints($s) <= 128, 'validation.password.max');
    }

    public static function uuid(): StringS
    {
        return self::string()->uuid('validation.uuid');
    }

    public static function isoDate(): StringS
    {
        return self::string()->regex('^\d{4}-\d{2}-\d{2}$', 'validation.date.format');
    }

    public static function isoDateTime(): StringS
    {
        return self::string()->datetime('validation.dateTime.format');
    }

    public static function percent(): StringS
    {
        return self::string()->regex('^\d{1,3}\.\d{2}$', 'validation.percent.format');
    }

    /** Masses: up to 3 decimals accepted and zero-padded to exactly 3; zero → `validation.positive`. */
    public static function massKg(): Effects
    {
        $positive = Ecma::compile('^(?!0+\.000$)\d{1,9}\.\d{3}$');

        return self::string()->regex('^\d{1,9}(\.\d{1,3})?$', 'validation.mass.format')
            ->transform(function (string $s): string {
                $parts = explode('.', $s, 2);

                return $parts[0].'.'.str_pad($parts[1] ?? '', 3, '0');
            })
            ->refine(fn (string $v) => Ecma::test($positive, $v), 'validation.positive');
    }

    public static function decimal(): StringS
    {
        return self::string()->regex('^\d{1,8}(\.\d{1,6})?$', 'validation.decimal.format');
    }

    public static function regionCode(): StringS
    {
        return self::string()->regex('^[0-9A-Z-]{1,8}$', 'validation.pattern');
    }

    public static function nameString(): Effects
    {
        return self::codePointString(1, 255, '\S');
    }

    /** `atLeastOneKey(schema)`: JSON Schema `minProperties: 1`. */
    public static function atLeastOneKey(ObjectS $schema): Effects
    {
        return $schema->refine(fn (array $obj) => $obj !== [], 'validation.minProperties');
    }

    /** `noDuplicate(field)` (superRefine on an array): every repeat of `field` → `[i].field: validation.duplicate`. */
    public static function noDuplicate(string $field): callable
    {
        return function (array $items, callable $add) use ($field): void {
            $seen = [];
            foreach ($items as $i => $item) {
                $v = is_array($item) ? ($item[$field] ?? null) : null;
                if (in_array($v, $seen, true)) {
                    $add('validation.duplicate', [$i, $field]);
                }
                $seen[] = $v;
            }
        };
    }

    /**
     * Unique array elements (`new Set(arr).size === arr.length`).
     *
     * @param  list<mixed>  $list
     */
    public static function unique(array $list): bool
    {
        $seen = [];
        foreach ($list as $v) {
            if (in_array($v, $seen, true)) {
                return false;
            }
            $seen[] = $v;
        }

        return true;
    }
}
