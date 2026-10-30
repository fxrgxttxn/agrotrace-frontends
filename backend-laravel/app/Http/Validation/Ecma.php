<?php

namespace App\Http\Validation;

use InvalidArgumentException;

/**
 * The ONLY place where a regular expression of the contract or of packages/validation becomes a PCRE pattern
 * (Global Constraints, R24 note, R21): the JavaScript (ECMA-262, `u` flag) semantics, not PCRE's —
 * - flags `u` (UTF-8 code points) and `D` (`$` is the very end: no match before a trailing "\n");
 * - `\s`/`\S` — JavaScript's white space and line terminators: ASCII \t \n \v \f \r and space, U+00A0, U+1680,
 *   U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF (PCRE's `\s` differs: no U+FEFF, U+00A0 only
 *   with UCP…);
 * - `\d` → `[0-9]`, `\w` → `[A-Za-z0-9_]` (and `\D`, `\W` their complements) — never Unicode digits/letters;
 * - `.` → any code point but \n, \r, U+2028, U+2029;
 * - `\uXXXX` / `\u{X…}` → `\x{…}`.
 * A schema `pattern` is a search, not a full match: callers use `preg_match(Ecma::compile($p), $s) === 1`.
 */
final class Ecma
{
    /** JavaScript `\s` as class members (without brackets). */
    public const WHITESPACE = '\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';

    private const DIGIT = '0-9';

    private const WORD = 'A-Za-z0-9_';

    private const DOT = '[^\n\r\x{2028}\x{2029}]';

    /**
     * A JavaScript regular expression source → a PCRE pattern with delimiters and the `uD` flags; `$flags` may add the
     * JavaScript `i` flag (case-insensitive matching, e.g. Zod's email and uuid checks).
     */
    public static function compile(string $pattern, string $flags = ''): string
    {
        if ($flags !== '' && $flags !== 'i') {
            throw new InvalidArgumentException("unsupported flags {$flags}");
        }
        $out = '';
        $n = strlen($pattern);
        $inClass = false;
        for ($i = 0; $i < $n; $i++) {
            $c = $pattern[$i];
            if ($c === '\\') {
                if ($i + 1 >= $n) {
                    throw new InvalidArgumentException("trailing backslash in pattern {$pattern}");
                }
                $e = $pattern[++$i];
                if ($e === 'u') {
                    [$hex, $i] = self::unicodeEscape($pattern, $i);
                    $out .= '\x{'.$hex.'}';

                    continue;
                }
                $out .= $inClass ? self::classEscape($e, $pattern) : self::escape($e);

                continue;
            }
            if ($inClass) {
                if ($c === ']') {
                    $inClass = false;
                } elseif ($c === '[') {
                    $c = '\['; // a literal `[` inside a JS class; PCRE would read `[:…:]` as POSIX
                } elseif ($c === '~') {
                    $c = '\~'; // the PCRE delimiter
                }
                $out .= $c;

                continue;
            }
            if ($c === '[') {
                $inClass = true;
                $out .= '[';
                // `[^` and a leading `]` (an empty class `[]` in JS matches nothing; refuse the ambiguity).
                if ($i + 1 < $n && $pattern[$i + 1] === '^') {
                    $out .= '^';
                    $i++;
                }
                if ($i + 1 < $n && $pattern[$i + 1] === ']') {
                    throw new InvalidArgumentException("empty character class in pattern {$pattern}");
                }

                continue;
            }
            $out .= match ($c) {
                '.' => self::DOT,
                '~' => '\~',
                default => $c,
            };
        }
        if ($inClass) {
            throw new InvalidArgumentException("unterminated character class in pattern {$pattern}");
        }

        return '~'.$out.'~uD'.$flags;
    }

    /** `preg_match` of a compiled pattern as a boolean; a subject that is not valid UTF-8 never matches. */
    public static function test(string $compiled, string $subject): bool
    {
        return preg_match($compiled, $subject) === 1;
    }

    private static function escape(string $e): string
    {
        return match ($e) {
            's' => '['.self::WHITESPACE.']',
            'S' => '[^'.self::WHITESPACE.']',
            'd' => '['.self::DIGIT.']',
            'D' => '[^'.self::DIGIT.']',
            'w' => '['.self::WORD.']',
            'W' => '[^'.self::WORD.']',
            '~' => '\~',
            default => '\\'.$e,
        };
    }

    private static function classEscape(string $e, string $pattern): string
    {
        return match ($e) {
            's' => self::WHITESPACE,
            'd' => self::DIGIT,
            'w' => self::WORD,
            'S', 'D', 'W' => throw new InvalidArgumentException(
                "\\{$e} inside a character class is not supported (pattern {$pattern})",
            ),
            '~' => '\~',
            default => '\\'.$e,
        };
    }

    /**
     * `\uXXXX` or `\u{X…}` starting at the `u` at $i.
     *
     * @return array{0: string, 1: int} hex digits and the index of the escape's last character
     */
    private static function unicodeEscape(string $pattern, int $i): array
    {
        if (preg_match('/\G\{([0-9A-Fa-f]{1,6})\}/', $pattern, $m, 0, $i + 1)) {
            return [$m[1], $i + strlen($m[0])];
        }
        if (preg_match('/\G[0-9A-Fa-f]{4}/', $pattern, $m, 0, $i + 1)) {
            return [$m[0], $i + 4];
        }
        throw new InvalidArgumentException("invalid \\u escape in pattern {$pattern}");
    }
}
