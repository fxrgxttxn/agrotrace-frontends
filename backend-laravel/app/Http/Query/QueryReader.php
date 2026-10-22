<?php

namespace App\Http\Query;

use App\Http\Problem\Problem;
use App\Http\Validation\Ecma;
use App\Http\Validation\Z\StringS;
use Illuminate\Http\Request;

/**
 * Query parameters by the contract's schemas (components/parameters.yaml; Express http/params.ts QueryReader), read
 * from the RAW `QUERY_STRING` (L8) the way Express's `qs` parser reads it — PHP's own parsing loses repeated keys and
 * turns `.` and spaces in names into `_`:
 * - `+` is a space; `%XX` is decoded, a malformed escape or invalid UTF-8 leaves the value as sent;
 * - a key given twice is a list, `name[]`/`name[0]` a list, `name[x]` an object — a scalar parameter in any of those
 *   forms is `validation.type`;
 * - every problem is collected under the parameter's name; `done()` throws one 400 with all of them.
 */
final class QueryReader
{
    private const PARAMETER_LIMIT = 1000;

    // Express 4.22 parses the query with qs `{arrayLimit: 1000}` (parameterLimit stays 1000).
    private const ARRAY_LIMIT = 1000;

    /** @var array<string, list<string>|array{__object: true}> */
    private array $params = [];

    /** @var array<string, list<string>> */
    public array $errors = [];

    public function __construct(string $queryString)
    {
        // qs parameterLimit 1000: only the first 1000 `&`-pieces are read (review M3).
        foreach (array_slice(explode('&', $queryString), 0, self::PARAMETER_LIMIT) as $piece) {
            if ($piece === '') {
                continue;
            }
            $eq = strpos($piece, '=');
            $key = self::decode($eq === false ? $piece : substr($piece, 0, $eq));
            $value = $eq === false ? '' : self::decode(substr($piece, $eq + 1));
            if ($key === '') {
                continue;
            }
            $open = strpos($key, '[');
            if ($open !== false && $open > 0 && str_ends_with($key, ']')) {
                $base = substr($key, 0, $open);
                $inner = substr($key, $open + 1, -1);
                // `a[]` and a canonical index 0…999 build a list, any other `a[…]` an object (review M3).
                if ($inner === '' || (ctype_digit($inner) && (string) (int) $inner === $inner && (int) $inner < self::ARRAY_LIMIT)) {
                    $current = $this->params[$base] ?? [];
                    if (! isset($current['__object'])) {
                        $current[] = $value;
                        $this->params[$base] = array_values($current);

                        continue;
                    }
                }
                $this->params[$base] = ['__object' => true];

                continue;
            }
            $current = $this->params[$key] ?? [];
            if (isset($current['__object'])) {
                continue;
            }
            $current[] = $value;
            $this->params[$key] = $current;
        }
    }

    public static function of(Request $request): self
    {
        return new self((string) $request->server->get('QUERY_STRING', ''));
    }

    /** qs' decoder: `+` → space, then decodeURIComponent; a failure keeps the (plus-replaced) text. */
    public static function decode(string $s): string
    {
        $s = str_replace('+', ' ', $s);
        if (! str_contains($s, '%')) {
            return $s;
        }
        $n = strlen($s);
        for ($i = 0; $i < $n; $i++) {
            if ($s[$i] === '%' && ($i + 2 >= $n || ! ctype_xdigit(substr($s, $i + 1, 2)))) {
                return $s;
            }
        }
        $decoded = rawurldecode($s);

        return mb_check_encoding($decoded, 'UTF-8') ? $decoded : $s;
    }

    public function has(string $name): bool
    {
        return array_key_exists($name, $this->params);
    }

    public function add(string $name, string $key): void
    {
        $this->errors[$name][] = $key;
    }

    /** One string value; a repeated or bracketed parameter is `validation.type`; absent → null. */
    public function string(string $name): ?string
    {
        if (! $this->has($name)) {
            return null;
        }
        $v = $this->params[$name];
        if (isset($v['__object']) || count($v) !== 1) {
            $this->add($name, 'validation.type');

            return null;
        }

        return $v[0];
    }

    /** An integer in [min, max]; `fallback` when absent. */
    public function int(string $name, int $min, ?int $max, ?int $fallback = null): ?int
    {
        $s = $this->string($name);
        if ($s === null) {
            return isset($this->errors[$name]) ? null : $fallback;
        }
        if (! Ecma::test(Ecma::compile('^-?\d{1,15}$'), $s)) {
            $this->add($name, 'validation.type');

            return null;
        }
        $n = (int) $s;
        if ($n < $min) {
            $this->add($name, 'validation.min');

            return null;
        }
        if ($max !== null && $n > $max) {
            $this->add($name, 'validation.max');

            return null;
        }

        return $n;
    }

    /** @param  list<string>  $values */
    public function enum(string $name, array $values): ?string
    {
        $s = $this->string($name);
        if ($s === null) {
            return null;
        }
        if (! in_array($s, $values, true)) {
            $this->add($name, 'validation.enum');

            return null;
        }

        return $s;
    }

    /**
     * A repeatable (`explode: true`) enum: `?type=A&type=B`; duplicates → validation.duplicate.
     *
     * @param  list<string>  $values
     * @return list<string>|null
     */
    public function enums(string $name, array $values): ?array
    {
        if (! $this->has($name)) {
            return null;
        }
        $list = $this->params[$name];
        if (isset($list['__object'])) {
            $this->add($name, 'validation.type');

            return null;
        }
        foreach ($list as $v) {
            if (! in_array($v, $values, true)) {
                $this->add($name, 'validation.enum');

                return null;
            }
        }
        if (count(array_unique($list)) !== count($list)) {
            $this->add($name, 'validation.duplicate');

            return null;
        }

        return $list;
    }

    /** A UUID, lower-cased. */
    public function uuid(string $name): ?string
    {
        $s = $this->string($name);
        if ($s === null) {
            return null;
        }
        if (! self::isUuid($s)) {
            $this->add($name, 'validation.uuid');

            return null;
        }

        return strtolower($s);
    }

    /** `Q`: 1…100 code points. */
    public function q(string $name = 'q'): ?string
    {
        $s = $this->string($name);
        if ($s === null) {
            return null;
        }
        $len = StringS::codePoints($s);
        if ($len < 1) {
            $this->add($name, 'validation.minLength');

            return null;
        }
        if ($len > 100) {
            $this->add($name, 'validation.maxLength');

            return null;
        }

        return $s;
    }

    /** A string with the contract's `maxLength` (code points). */
    public function text(string $name, int $maxLength): ?string
    {
        $s = $this->string($name);
        if ($s === null) {
            return null;
        }
        if (StringS::codePoints($s) > $maxLength) {
            $this->add($name, 'validation.maxLength');

            return null;
        }

        return $s;
    }

    /** A string matching a contract `pattern` (JavaScript source) — otherwise `validation.pattern`. */
    public function matching(string $name, string $jsPattern): ?string
    {
        $s = $this->string($name);
        if ($s === null) {
            return null;
        }
        if (! Ecma::test(Ecma::compile($jsPattern), $s)) {
            $this->add($name, 'validation.pattern');

            return null;
        }

        return $s;
    }

    /** `type: boolean` — exactly `true` or `false`. */
    public function bool(string $name): ?bool
    {
        $s = $this->string($name);
        if ($s === null) {
            return null;
        }
        if ($s !== 'true' && $s !== 'false') {
            $this->add($name, 'validation.type');

            return null;
        }

        return $s === 'true';
    }

    /** `format: date` — a real calendar date `YYYY-MM-DD`. */
    public function date(string $name): ?string
    {
        $s = $this->string($name);
        if ($s === null) {
            return null;
        }
        if (! self::isCalendarDate($s)) {
            $this->add($name, 'validation.date.format');

            return null;
        }

        return $s;
    }

    /**
     * `DateFrom`/`DateTo` (inclusive): `from` after `to` → `errors.from: [validation.range]`.
     *
     * @return array{from: ?string, to: ?string}
     */
    public function dateRange(): array
    {
        $from = $this->date('from');
        $to = $this->date('to');
        if ($from !== null && $to !== null && strcmp($from, $to) > 0) {
            $this->add('from', 'validation.range');
        }

        return ['from' => $from, 'to' => $to];
    }

    /** R51: a filter this caller may not use — present (any value, `false` included) → `validation.<name>.notAllowed`. */
    public function notAllowed(string $name): void
    {
        if ($this->has($name)) {
            $this->errors[$name] = ["validation.{$name}.notAllowed"];
        }
    }

    /**
     * `Page`, `Size` (1…100, default 20) and `Sort` against the operation's `x-sort`.
     *
     * @param  list<string>  $fields
     * @return array{page: int, size: int, sort: array{field: string, dir: string}}
     */
    public function page(array $fields, string $default): array
    {
        $page = $this->int('page', 1, null, 1) ?? 1;
        $size = $this->int('size', 1, 100, 20) ?? 20;
        $raw = $this->string('sort') ?? (isset($this->errors['sort']) ? null : $default);
        [$f, $d] = explode(',', $default);
        $sort = ['field' => $f, 'dir' => $d];
        if ($raw !== null) {
            $parts = explode(',', $raw);
            if (count($parts) !== 2 || ! ctype_alpha($parts[0]) || ! in_array($parts[1], ['asc', 'desc'], true)
                || ! in_array($parts[0], $fields, true)) {
                $this->add('sort', 'validation.sort');
            } else {
                $sort = ['field' => $parts[0], 'dir' => $parts[1]];
            }
        }

        return ['page' => $page, 'size' => $size, 'sort' => $sort];
    }

    /** Throws the 400 with every error collected so far. */
    public function done(): void
    {
        if ($this->errors !== []) {
            throw Problem::validation($this->errors);
        }
    }

    public static function isUuid(string $s): bool
    {
        return Ecma::test(Ecma::compile('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'i'), $s);
    }

    public static function isCalendarDate(string $s): bool
    {
        if (! Ecma::test(Ecma::compile('^\d{4}-\d{2}-\d{2}$'), $s)) {
            return false;
        }
        [$y, $m, $d] = array_map('intval', explode('-', $s));

        return $y >= 1 && checkdate($m, $d, $y);
    }
}
