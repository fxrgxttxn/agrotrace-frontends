<?php

namespace App\Infrastructure\I18n;

use RuntimeException;

/**
 * Texts of packages/i18n/locales/ru.json (`mail.*`, notification templates), resolved and substituted exactly as
 * packages/i18n (resolve.ts, substitute): a dotted key, the flat key of a namespace first, then segment by segment;
 * every `{name}` of the params replaced; a missing key is the key itself. The image carries a copy of the file
 * (Dockerfile); php-tools reads the repository's.
 */
final class Messages
{
    /** @param  array<string, string|int>  $params */
    public static function t(string $key, array $params = []): string
    {
        $template = self::resolve(self::dict(), $key) ?? $key;
        foreach ($params as $name => $value) {
            $template = str_replace('{'.$name.'}', (string) $value, $template);
        }

        return $template;
    }

    /** @param  array<string, mixed>  $dict */
    private static function resolve(array $dict, string $key): ?string
    {
        $dot = strpos($key, '.');
        if ($dot === false) {
            return is_string($dict[$key] ?? null) ? $dict[$key] : null;
        }
        $node = $dict[substr($key, 0, $dot)] ?? null;
        if (! is_array($node)) {
            return null;
        }
        $rest = substr($key, $dot + 1);
        if (is_string($node[$rest] ?? null)) {
            return $node[$rest];
        }
        $cursor = $node;
        foreach (explode('.', $rest) as $segment) {
            if (! is_array($cursor)) {
                return null;
            }
            $cursor = $cursor[$segment] ?? null;
        }

        return is_string($cursor) ? $cursor : null;
    }

    /** @return array<string, mixed> */
    private static function dict(): array
    {
        $raw = @file_get_contents(self::path());
        if ($raw === false) {
            throw new RuntimeException('i18n dictionary not found: '.self::path());
        }

        return json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
    }

    public static function path(): string
    {
        $configured = config('agrotrace.i18n_path');
        if (is_string($configured) && $configured !== '') {
            return $configured;
        }
        $image = base_path('resources/i18n/ru.json');

        return is_file($image) ? $image : dirname(base_path()).'/packages/i18n/locales/ru.json';
    }
}
