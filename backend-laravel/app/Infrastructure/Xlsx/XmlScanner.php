<?php

namespace App\Infrastructure\Xlsx;

/**
 * A linear, namespace-aware XML scanner for the XLSX pre-scan (P24–P28; Express xlsx-scan.ts `scanXml`), over UTF-8
 * text (the caller checked the encoding): no regular expression — `strpos`/`strspn`/`strcspn` jumps plus one pass over
 * each tag, so an adversarial part costs time proportional to its size and a limit stops the scan at once.
 *
 * It refuses what is not namespace-well-formed XML 1.0 (the contract's list, P27/P28): a character outside XML's Char
 * production, an encoding label other than UTF-8, DOCTYPE/entity declarations, `--` inside a comment, a malformed tag
 * or QName, `<` in an attribute value, a duplicate attribute (by name or expanded name), an undefined entity or an
 * illegal character reference, an unbound prefix, a misused reserved binding (`xml`, `xmlns`), a mismatched end tag,
 * an unclosed element, a second root, non-whitespace text or CDATA outside the root, nesting deeper than 256.
 *
 * `onTag(end, selfClosing, localName, prefixed, ns, defaultNs, attrs)` is called for every tag in order; `attrs` holds
 * the decoded attributes of the tags `wantAttrs(localName)` asks for — an unprefixed one by its name, a prefixed one
 * as `{namespace}local`.
 */
final class XmlScanner
{
    public const XML_NS = 'http://www.w3.org/XML/1998/namespace';

    public const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

    private const MAX_DEPTH = 256;

    private const SPACE = " \t\n\r";

    /** C0 controls XML 1.0 forbids (TAB, LF, CR are allowed). */
    private const C0 = "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A\x1B\x1C\x1D\x1E\x1F";

    private const NAMED = ['amp' => '&', 'lt' => '<', 'gt' => '>', 'quot' => '"', 'apos' => "'"];

    /**
     * @param  callable(string): bool  $wantAttrs
     * @param  callable(bool, bool, string, bool, string, ?string, array<string, string>): void  $onTag
     *
     * @throws ScanError
     */
    public static function scan(string $text, callable $wantAttrs, callable $onTag): void
    {
        $n = strlen($text);
        // Char production: C0 controls (but TAB/LF/CR), U+FFFE and U+FFFF.
        if (strcspn($text, self::C0) !== $n || str_contains($text, "\xEF\xBF\xBE") || str_contains($text, "\xEF\xBF\xBF")) {
            throw new ScanError('malformed');
        }
        /** @var list<array{0: string, 1: ?list<array{0: string, 1: ?string}>}> $stack */
        $stack = [];
        $depth = 0;
        /** @var array<string, ?string> $bindings */
        $bindings = ['xml' => self::XML_NS];
        $nextAmp = -2;
        $rootSeen = false;
        $rootDone = false;
        $i = 0;
        for (; ;) {
            $lt = strpos($text, '<', $i);
            $segEnd = $lt === false ? $n : $lt;
            if ($segEnd > $i) {
                if ($depth === 0) {
                    // Outside the root only whitespace.
                    if (strspn($text, self::SPACE, $i, $segEnd - $i) !== $segEnd - $i) {
                        throw new ScanError('malformed');
                    }
                } else {
                    // The references of this segment; the next `&` is remembered (one pass over the document).
                    $from = $i;
                    for (; ;) {
                        if ($nextAmp !== -1 && $nextAmp < $from) {
                            $f = strpos($text, '&', $from);
                            $nextAmp = $f === false ? -1 : $f;
                        }
                        if ($nextAmp < 0 || $nextAmp >= $segEnd) {
                            break;
                        }
                        $semi = strpos($text, ';', $nextAmp);
                        if ($semi === false || $semi > $segEnd) {
                            throw new ScanError('malformed');
                        }
                        self::entityText(substr($text, $nextAmp + 1, $semi - $nextAmp - 1));
                        $from = $semi + 1;
                    }
                }
            }
            if ($lt === false) {
                break;
            }
            $c = $lt + 1 < $n ? $text[$lt + 1] : '';
            if ($c === '?') {
                $end = strpos($text, '?>', $lt + 2);
                if ($end === false) {
                    throw new ScanError('malformed');
                }
                if (substr_compare($text, '<?xml', $lt, 5) === 0 && $lt + 5 < $n && str_contains(self::SPACE, $text[$lt + 5])) {
                    // The XML declaration: an encoding label, if any, is exactly UTF-8 (any case) — P27, P28.
                    $decl = substr($text, $lt, $end - $lt);
                    $k = strpos($decl, 'encoding');
                    if ($k !== false) {
                        $q = strpos($decl, '"', $k);
                        $q2 = strpos($decl, "'", $k);
                        if ($q === false || ($q2 !== false && $q2 < $q)) {
                            $q = $q2;
                        }
                        $close = $q === false ? false : strpos($decl, $decl[$q], $q + 1);
                        if ($close === false || strtolower(substr($decl, $q + 1, $close - $q - 1)) !== 'utf-8') {
                            throw new ScanError('malformed');
                        }
                    }
                }
                $i = $end + 2;

                continue;
            }
            if ($c === '!') {
                if (substr_compare($text, '<!--', $lt, 4) === 0) {
                    $close = strpos($text, '-->', $lt + 4);
                    if ($close === false) {
                        throw new ScanError('malformed');
                    }
                    // No `--` inside a comment, and it may not end in `-` (`--->`).
                    $dd = strpos($text, '--', $lt + 4);
                    if ($dd < $close || ($close > $lt + 4 && $text[$close - 1] === '-')) {
                        throw new ScanError('malformed');
                    }
                    $i = $close + 3;
                } elseif ($depth > 0 && substr_compare($text, '<![CDATA[', $lt, 9) === 0) {
                    $close = strpos($text, ']]>', $lt + 9);
                    if ($close === false) {
                        throw new ScanError('malformed');
                    }
                    $i = $close + 3;
                } else {
                    throw new ScanError('malformed'); // DOCTYPE, entity declarations, CDATA outside the root
                }

                continue;
            }
            $isEnd = $c === '/';
            $p = $lt + ($isEnd ? 2 : 1);
            $nameLen = strcspn($text, " \t\n\r/></", $p);
            if ($nameLen === 0 || $p + $nameLen >= $n) {
                throw new ScanError('malformed');
            }
            $qname = substr($text, $p, $nameLen);
            $p += $nameLen;
            [$prefix, $name] = self::split($qname);
            if ($prefix === 'xmlns') {
                throw new ScanError('malformed'); // a reserved prefix, never an element's
            }

            if ($isEnd) {
                $p += strspn($text, self::SPACE, $p);
                if ($p >= $n || $text[$p] !== '>') {
                    throw new ScanError('malformed');
                }
                if ($depth === 0 || $stack[$depth - 1][0] !== $qname) {
                    throw new ScanError('malformed');
                }
                $undo = $stack[--$depth][1];
                unset($stack[$depth]);
                $ns = $prefix !== '' ? ($bindings[$prefix] ?? '') : ($bindings[''] ?? '');
                if ($undo !== null) {
                    for ($k = count($undo) - 1; $k >= 0; $k--) {
                        $bindings[$undo[$k][0]] = $undo[$k][1];
                    }
                }
                if ($depth === 0) {
                    $rootDone = true;
                }
                $i = $p + 1;
                $onTag(true, false, $name, $prefix !== '', $ns, null, []);

                continue;
            }

            if ($rootDone) {
                throw new ScanError('malformed'); // a second root element
            }
            $collect = $wantAttrs($name);
            $seen = [];
            $prefixedAttrs = [];
            $plain = [];
            $decls = null;
            $defaultNs = null;
            $selfClosing = false;
            for (; ;) {
                $p += strspn($text, self::SPACE, $p);
                if ($p >= $n) {
                    throw new ScanError('malformed');
                }
                $ch = $text[$p];
                if ($ch === '>') {
                    $p++;
                    break;
                }
                if ($ch === '/') {
                    if ($p + 1 >= $n || $text[$p + 1] !== '>') {
                        throw new ScanError('malformed');
                    }
                    $selfClosing = true;
                    $p += 2;
                    break;
                }
                $attrLen = strcspn($text, " \t\n\r=>/<", $p);
                if ($attrLen === 0) {
                    throw new ScanError('malformed');
                }
                $attrName = substr($text, $p, $attrLen);
                $p += $attrLen;
                if (isset($seen[$attrName])) {
                    throw new ScanError('malformed');
                }
                $seen[$attrName] = true;
                $p += strspn($text, self::SPACE, $p);
                if ($p >= $n || $text[$p] !== '=') {
                    throw new ScanError('malformed');
                }
                $p++;
                $p += strspn($text, self::SPACE, $p);
                $q = $p < $n ? $text[$p] : '';
                if ($q !== '"' && $q !== "'") {
                    throw new ScanError('malformed');
                }
                $close = strpos($text, $q, $p + 1);
                if ($close === false) {
                    throw new ScanError('malformed');
                }
                $raw = substr($text, $p + 1, $close - $p - 1);
                if (str_contains($raw, '<')) {
                    throw new ScanError('malformed');
                }
                $value = str_contains($raw, '&') ? self::decode($raw) : $raw;
                $p = $close + 1;
                [$ap, $al] = self::split($attrName);
                if ($ap === '' && $al === 'xmlns') {
                    if ($value === self::XML_NS || $value === self::XMLNS_NS) {
                        throw new ScanError('malformed'); // reserved namespaces are never a default
                    }
                    $defaultNs = $value;
                    $decls[''] = $value;
                } elseif ($ap === 'xmlns') {
                    // Reserved bindings (P28): `xml` only to its own namespace, `xmlns` never; no other prefix to either.
                    if ($al === 'xmlns' || $value === '' || $value === self::XMLNS_NS) {
                        throw new ScanError('malformed');
                    }
                    if (($al === 'xml') !== ($value === self::XML_NS)) {
                        throw new ScanError('malformed');
                    }
                    if ($al !== 'xml') {
                        $decls[$al] = $value;
                    }
                } elseif ($ap !== '') {
                    $prefixedAttrs[] = [$ap, $al, $value];
                } elseif ($collect) {
                    $plain[$al] = $value;
                }
            }

            $undo = null;
            if ($decls !== null) {
                $undo = [];
                foreach ($decls as $pfx => $uri) {
                    $pfx = (string) $pfx;
                    $undo[] = [$pfx, $bindings[$pfx] ?? null];
                    $bindings[$pfx] = ($pfx === '' && $uri === '') ? null : $uri;
                }
            }
            if ($prefix !== '') {
                $bound = $bindings[$prefix] ?? null;
                if ($bound === null) {
                    throw new ScanError('malformed'); // unbound prefix
                }
                $ns = $bound;
            } else {
                $ns = $bindings[''] ?? '';
            }
            $attrs = $plain;
            if ($prefixedAttrs !== []) {
                $expanded = [];
                foreach ($prefixedAttrs as [$ap, $al, $value]) {
                    $uri = $bindings[$ap] ?? null;
                    if ($uri === null) {
                        throw new ScanError('malformed'); // unbound attribute prefix
                    }
                    $key = '{'.$uri.'}'.$al;
                    if (isset($expanded[$key])) {
                        throw new ScanError('malformed'); // the same expanded name twice
                    }
                    $expanded[$key] = true;
                    if ($collect) {
                        $attrs[$key] = $value;
                    }
                }
            }

            $rootSeen = true;
            if ($selfClosing) {
                if ($undo !== null) {
                    for ($k = count($undo) - 1; $k >= 0; $k--) {
                        $bindings[$undo[$k][0]] = $undo[$k][1];
                    }
                }
                if ($depth === 0) {
                    $rootDone = true;
                }
            } else {
                $stack[$depth++] = [$qname, $undo];
                if ($depth > self::MAX_DEPTH) {
                    throw new ScanError('malformed');
                }
            }
            $i = $p;
            $onTag(false, $selfClosing, $name, $prefix !== '', $ns, $defaultNs, $attrs);
        }
        if (! $rootSeen || $depth > 0) {
            throw new ScanError('malformed'); // no root, or an unclosed element
        }
    }

    /**
     * A QName: `local` or `prefix:local`, both parts non-empty, at most one `:` (P28).
     *
     * @return array{0: string, 1: string}
     */
    public static function split(string $q): array
    {
        $i = strpos($q, ':');
        if ($i === false) {
            return ['', $q];
        }
        if ($i === 0 || $i === strlen($q) - 1 || strpos($q, ':', $i + 1) !== false) {
            throw new ScanError('malformed');
        }

        return [substr($q, 0, $i), substr($q, $i + 1)];
    }

    /** A code point XML 1.0 allows (Char production). */
    public static function legalChar(int $c): bool
    {
        return $c === 0x9 || $c === 0xA || $c === 0xD || ($c >= 0x20 && $c <= 0xD7FF)
            || ($c >= 0xE000 && $c <= 0xFFFD) || ($c >= 0x10000 && $c <= 0x10FFFF);
    }

    /**
     * The text of an entity or character reference (`amp`, `#58`, `#x0000003A`); malformed when undefined or illegal.
     * A numeric reference may have any number of digits (leading zeros) as long as its value is a legal Char.
     */
    public static function entityText(string $ent): string
    {
        if (isset(self::NAMED[$ent])) {
            return self::NAMED[$ent];
        }
        $len = strlen($ent);
        if ($len < 2 || $ent[0] !== '#') {
            throw new ScanError('malformed');
        }
        $hex = $ent[1] === 'x';
        $from = $hex ? 2 : 1;
        if ($from >= $len) {
            throw new ScanError('malformed');
        }
        $allowed = $hex ? '0123456789abcdefABCDEF' : '0123456789';
        if (strspn($ent, $allowed, $from) !== $len - $from) {
            throw new ScanError('malformed');
        }
        $digits = ltrim(substr($ent, $from), '0');
        if (strlen($digits) > 8) {
            throw new ScanError('malformed');
        }
        $v = $digits === '' ? 0 : ($hex ? hexdec($digits) : (int) $digits);
        if (! is_int($v) || $v > 0x10FFFF || ! self::legalChar($v)) {
            throw new ScanError('malformed');
        }

        return (string) mb_chr($v, 'UTF-8');
    }

    /** Entity-decodes an attribute value, validating every reference. */
    public static function decode(string $v): string
    {
        $out = '';
        $i = 0;
        for (; ;) {
            $amp = strpos($v, '&', $i);
            if ($amp === false) {
                return $out.substr($v, $i);
            }
            $semi = strpos($v, ';', $amp);
            if ($semi === false) {
                throw new ScanError('malformed');
            }
            $out .= substr($v, $i, $amp - $i).self::entityText(substr($v, $amp + 1, $semi - $amp - 1));
            $i = $semi + 1;
        }
    }
}
