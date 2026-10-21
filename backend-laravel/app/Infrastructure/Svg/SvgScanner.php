<?php

namespace App\Infrastructure\Svg;

use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;

/**
 * The streaming pre-scan of an SVG logo before any DOM (P15, P18; a port of Express infra/svg.ts `scanSvg`): linear in
 * the input — only strpos/strspn, no backtracking regular expression:
 * - no DOCTYPE or other `<!…>` declaration (hence no entities); comments, processing instructions and CDATA
 *   terminated; start/end tags balanced;
 * - element names from the allowlist only (case-sensitive, no prefixes) — anything else is refused, not sanitized;
 * - complexity limits: nesting ≤ 64, ≤ 5 000 elements, ≤ 100 attributes per element and ≤ 20 000 in all, ≤ 32
 *   namespace declarations (`xmlns`, `xmlns:*`), every attribute value ≤ 64 KiB (UTF-16 code units, as in
 *   JavaScript), no `<` in a value.
 * A limit → 415 `{allowed, reason: "svg-too-complex"}`; any other violation → 415 `{allowed}`.
 */
final class SvgScanner
{
    public const MAX_DEPTH = 64;

    public const MAX_ELEMENTS = 5000;

    public const MAX_ATTRS_PER_ELEMENT = 100;

    public const MAX_ATTRS = 20_000;

    public const MAX_NAMESPACES = 32;

    public const MAX_ATTR_VALUE = 65536;

    public const ELEMENTS = [
        'svg', 'g', 'defs', 'desc', 'title', 'metadata', 'symbol', 'switch', 'a',
        'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect',
        'text', 'tspan', 'textPath', 'image',
        'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop',
        'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
        'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB',
        'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight',
        'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
    ];

    private const NAME_START = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_';

    private const NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-';

    private const SPACE = " \t\r\n";

    /** @param  list<string>  $allowed  the 415 `params.allowed` */
    public static function scan(string $text, array $allowed): void
    {
        $r = self::check($text);
        if ($r !== null) {
            throw self::refusal($allowed, $r['tooComplex']);
        }
    }

    /** @param  list<string>  $allowed */
    public static function refusal(array $allowed, bool $tooComplex): Problem
    {
        return new Problem(415, ProblemCode::UNSUPPORTED_MEDIA_TYPE,
            params: $tooComplex ? ['allowed' => $allowed, 'reason' => 'svg-too-complex'] : ['allowed' => $allowed]);
    }

    /**
     * null — the document passes; else why and whether it is a complexity limit.
     *
     * @return array{tooComplex: bool, why: string}|null
     */
    public static function check(string $text): ?array
    {
        $elements = array_flip(self::ELEMENTS);
        $refuse = fn (string $why) => ['tooComplex' => false, 'why' => $why];
        $tooComplex = fn (string $why) => ['tooComplex' => true, 'why' => $why];
        $n = strlen($text);
        $i = 0;
        $depth = 0;
        $count = 0;
        $attrs = 0;
        $namespaces = 0;
        for (; ;) {
            $lt = strpos($text, '<', $i);
            if ($lt === false) {
                if ($count === 0) {
                    return $refuse('no element');
                }

                return $depth === 0 ? null : $refuse('unclosed element');
            }
            if (substr_compare($text, '<!--', $lt, 4) === 0) {
                $end = strpos($text, '-->', $lt + 4);
                if ($end === false) {
                    return $refuse('unterminated comment');
                }
                $i = $end + 3;

                continue;
            }
            if (substr_compare($text, '<![CDATA[', $lt, 9) === 0) {
                $end = strpos($text, ']]>', $lt + 9);
                if ($end === false) {
                    return $refuse('unterminated CDATA');
                }
                $i = $end + 3;

                continue;
            }
            if (substr_compare($text, '<?', $lt, 2) === 0) {
                $end = strpos($text, '?>', $lt + 2);
                if ($end === false) {
                    return $refuse('unterminated processing instruction');
                }
                $i = $end + 2;

                continue;
            }
            $next = $text[$lt + 1] ?? '';
            if ($next === '!') {
                return $refuse('declaration (DOCTYPE/ENTITY)');
            }
            if ($next === '/') {
                $end = strpos($text, '>', $lt);
                if ($end === false) {
                    return $refuse('unterminated end tag');
                }
                $depth--;
                if ($depth < 0) {
                    return $refuse('unbalanced end tag');
                }
                $i = $end + 1;

                continue;
            }
            $name = self::name($text, $lt + 1);
            if ($name === null) {
                return $refuse('malformed start tag');
            }
            if (! isset($elements[$name])) {
                return $refuse("element {$name} is not allowed");
            }
            $count++;
            if ($count > self::MAX_ELEMENTS) {
                return $tooComplex('too many elements');
            }
            $j = $lt + 1 + strlen($name);
            $own = 0;
            $selfClosing = false;
            for (; ;) {
                $j += strspn($text, self::SPACE, $j);
                if ($j >= $n) {
                    return $refuse('unterminated start tag');
                }
                if ($text[$j] === '>') {
                    break;
                }
                if ($text[$j] === '/' && ($text[$j + 1] ?? '') === '>') {
                    $selfClosing = true;
                    $j++;
                    break;
                }
                $attr = self::name($text, $j);
                if ($attr === null) {
                    return $refuse('malformed attribute');
                }
                $j += strlen($attr);
                $j += strspn($text, self::SPACE, $j);
                if (($text[$j] ?? '') !== '=') {
                    return $refuse('attribute without a value');
                }
                $j++;
                $j += strspn($text, self::SPACE, $j);
                $quote = $text[$j] ?? '';
                if ($quote !== '"' && $quote !== "'") {
                    return $refuse('unquoted attribute value');
                }
                $end = strpos($text, $quote, $j + 1);
                if ($end === false) {
                    return $refuse('unterminated attribute value');
                }
                $len = $end - $j - 1;
                if ($len > self::MAX_ATTR_VALUE && self::utf16Length(substr($text, $j + 1, $len)) > self::MAX_ATTR_VALUE) {
                    return $tooComplex('attribute value too long');
                }
                if ($len > 0 && strcspn($text, '<', $j + 1, $len) !== $len) {
                    return $refuse('`<` in an attribute value');
                }
                $j = $end + 1;
                $own++;
                $attrs++;
                if ($attr === 'xmlns' || str_starts_with($attr, 'xmlns:')) {
                    $namespaces++;
                }
                if ($own > self::MAX_ATTRS_PER_ELEMENT) {
                    return $tooComplex('too many attributes on an element');
                }
                if ($attrs > self::MAX_ATTRS) {
                    return $tooComplex('too many attributes');
                }
                if ($namespaces > self::MAX_NAMESPACES) {
                    return $tooComplex('too many namespace declarations');
                }
            }
            if (! $selfClosing) {
                $depth++;
                if ($depth > self::MAX_DEPTH) {
                    return $tooComplex('nested too deeply');
                }
            }
            $i = $j + 1;
        }
    }

    /** `[A-Za-z_][\w.:-]*` at $at (ASCII, as the JavaScript `\w`), or null. */
    private static function name(string $text, int $at): ?string
    {
        if ($at >= strlen($text) || strspn($text, self::NAME_START, $at, 1) !== 1) {
            return null;
        }

        return substr($text, $at, 1 + strspn($text, self::NAME_CHARS, $at + 1));
    }

    private static function utf16Length(string $s): int
    {
        return intdiv(strlen((string) mb_convert_encoding($s, 'UTF-16LE', 'UTF-8')), 2);
    }
}
