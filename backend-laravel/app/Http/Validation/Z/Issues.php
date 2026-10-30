<?php

namespace App\Http\Validation\Z;

/**
 * The issues of one parse, in the order Zod raises them; `fieldErrors()` is `toFieldErrors` of packages/validation:
 * path → i18n keys, `items[0].field`, `_root` for the body itself.
 */
final class Issues
{
    /** @var list<array{path: list<string|int>, message: string}> */
    private array $list = [];

    /** @param  list<string|int>  $path */
    public function add(array $path, string $message): void
    {
        $this->list[] = ['path' => $path, 'message' => $message];
    }

    public function empty(): bool
    {
        return $this->list === [];
    }

    /** @return list<array{path: list<string|int>, message: string}> */
    public function all(): array
    {
        return $this->list;
    }

    /** @return array<string, list<string>> */
    public function fieldErrors(): array
    {
        $out = [];
        foreach ($this->list as $issue) {
            $out[self::formatPath($issue['path'])][] = $issue['message'];
        }

        return $out;
    }

    /** @param  list<string|int>  $path */
    public static function formatPath(array $path): string
    {
        if ($path === []) {
            return '_root';
        }
        $acc = '';
        foreach ($path as $seg) {
            $acc = is_int($seg) ? "{$acc}[{$seg}]" : ($acc === '' ? $seg : "{$acc}.{$seg}");
        }

        return $acc;
    }
}
