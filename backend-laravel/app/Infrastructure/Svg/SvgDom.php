<?php

namespace App\Infrastructure\Svg;

use App\Http\Validation\Ecma;
use DOMAttr;
use DOMDocument;
use DOMElement;
use DOMNode;
use DOMXPath;

/**
 * The DOM part of SVG logo sanitization (spec 8.6, Review Focus #5, P15/P17/P20) — a port of Express
 * infra/svg-sanitize.ts (DOMPurify with the svg + svgFilters profiles and the AgroTrace hook). Framework-free: it runs
 * in the sandbox child (resources/sandbox/svg-sanitize.php) and only on documents that passed SvgScanner (bounded,
 * no DOCTYPE, allowlisted element names).
 *
 * 1. The document must be well-formed XML (libxml, LIBXML_NONET, no entity substitution) whose root is `svg` in the
 *    SVG namespace.
 * 2. Elements outside the SVG namespace are removed; comments and processing instructions too; CDATA becomes text.
 * 3. Attributes (DOMPurify's order): the hook first — `style` keeps only allowlisted presentation properties with plain
 *    values; `fill`/`stroke`/`filter`/`mask`/`clip-path`/`marker*` are dropped with `\`, `expression(` or any `url(…)`
 *    other than `url(#id)`; `href`/`xlink:href` only `#…` (a raster `data:` URI in `<image>` allowed); any value with
 *    a non-local `url(…)`, `@import`, `expression(` or `javascript:` is dropped — then DOMPurify's checks: the SVG/XML
 *    attribute allowlist (`data-*`, `aria-*` too; `on*` handlers never), values safe for XML, URI-safe values.
 * 4. The result is serialized as XML and parsed again to prove it is well-formed.
 */
final class SvgDom
{
    public const SVG_NS = 'http://www.w3.org/2000/svg';

    private const XLINK_NS = 'http://www.w3.org/1999/xlink';

    /** DOMPurify `svg` attributes + `xml` attributes (dompurify 3.4.16 attrs.js), lower-case. */
    private const ALLOWED_ATTR = [
        'accent-height', 'accumulate', 'additive', 'alignment-baseline', 'amplitude', 'ascent', 'attributename',
        'attributetype', 'azimuth', 'basefrequency', 'baseline-shift', 'begin', 'bias', 'by', 'class', 'clip',
        'clippathunits', 'clip-path', 'clip-rule', 'color', 'color-interpolation', 'color-interpolation-filters',
        'color-profile', 'color-rendering', 'cx', 'cy', 'd', 'dx', 'dy', 'diffuseconstant', 'direction', 'display',
        'divisor', 'dominant-baseline', 'dur', 'edgemode', 'elevation', 'end', 'exponent', 'fill', 'fill-opacity',
        'fill-rule', 'filter', 'filterunits', 'flood-color', 'flood-opacity', 'font-family', 'font-size',
        'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight', 'fx', 'fy', 'g1', 'g2',
        'glyph-name', 'glyphref', 'gradientunits', 'gradienttransform', 'height', 'href', 'id', 'image-rendering', 'in',
        'in2', 'intercept', 'k', 'k1', 'k2', 'k3', 'k4', 'kerning', 'keypoints', 'keysplines', 'keytimes', 'lang',
        'lengthadjust', 'letter-spacing', 'kernelmatrix', 'kernelunitlength', 'lighting-color', 'local', 'marker-end',
        'marker-mid', 'marker-start', 'markerheight', 'markerunits', 'markerwidth', 'maskcontentunits', 'maskunits',
        'max', 'mask', 'mask-type', 'media', 'method', 'mode', 'min', 'name', 'numoctaves', 'offset', 'operator',
        'opacity', 'order', 'orient', 'orientation', 'origin', 'overflow', 'paint-order', 'path', 'pathlength',
        'patterncontentunits', 'patterntransform', 'patternunits', 'pointer-events', 'points', 'preservealpha',
        'preserveaspectratio', 'primitiveunits', 'r', 'rx', 'ry', 'radius', 'refx', 'refy', 'repeatcount', 'repeatdur',
        'restart', 'result', 'rotate', 'scale', 'seed', 'shape-rendering', 'slope', 'specularconstant',
        'specularexponent', 'spreadmethod', 'startoffset', 'stddeviation', 'stitchtiles', 'stop-color', 'stop-opacity',
        'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
        'stroke-opacity', 'stroke', 'stroke-width', 'style', 'surfacescale', 'systemlanguage', 'tabindex', 'tablevalues',
        'targetx', 'targety', 'transform', 'transform-origin', 'text-anchor', 'text-decoration', 'text-orientation',
        'text-rendering', 'textlength', 'type', 'u1', 'u2', 'unicode', 'values', 'vector-effect', 'viewbox',
        'visibility', 'version', 'vert-adv-y', 'vert-origin-x', 'vert-origin-y', 'width', 'word-spacing', 'wrap',
        'writing-mode', 'xchannelselector', 'ychannelselector', 'x', 'x1', 'x2', 'xmlns', 'y', 'y1', 'y2', 'z',
        'zoomandpan',
        'xlink:href', 'xml:id', 'xlink:title', 'xml:space', 'xmlns:xlink',
    ];

    /** DOMPurify `svg` + `svgFilters` tags (dompurify 3.4.16 tags.js), lower-case. */
    private const ALLOWED_TAGS = [
        'svg', 'a', 'altglyph', 'altglyphdef', 'altglyphitem', 'animatecolor', 'animatemotion', 'animatetransform',
        'circle', 'clippath', 'defs', 'desc', 'ellipse', 'enterkeyhint', 'exportparts', 'filter', 'font', 'g', 'glyph',
        'glyphref', 'hkern', 'image', 'inputmode', 'line', 'lineargradient', 'marker', 'mask', 'metadata', 'mpath',
        'part', 'path', 'pattern', 'polygon', 'polyline', 'radialgradient', 'rect', 'stop', 'style', 'switch', 'symbol',
        'text', 'textpath', 'title', 'tref', 'tspan', 'view', 'vkern',
        'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix', 'fediffuselighting',
        'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
        'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology', 'feoffset', 'fepointlight',
        'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
    ];

    /** FORBID_TAGS of the Express call. */
    private const FORBID_TAGS = ['style', 'foreignobject', 'script'];

    /** DOMPurify DEFAULT_FORBID_CONTENTS (the elements whose content goes with them). */
    private const FORBID_CONTENTS = [
        'annotation-xml', 'audio', 'colgroup', 'desc', 'foreignobject', 'head', 'iframe', 'math', 'mi', 'mn', 'mo', 'ms',
        'mtext', 'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'selectedcontent', 'style', 'svg', 'template', 'thead', 'title',
        'video', 'xmp',
    ];

    /** DOMPurify URI_SAFE_ATTRIBUTES: values never URI-checked. */
    private const URI_SAFE = ['alt', 'class', 'for', 'id', 'label', 'name', 'pattern', 'placeholder', 'role', 'summary', 'title', 'value', 'style', 'xmlns'];

    private const STYLE_PROPERTIES = ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'text-anchor', 'display', 'visibility'];

    private const CSS_ATTRIBUTES = ['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'marker'];

    /** JavaScript String#trim white space (UTF-8). */
    private const JS_SPACE = "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

    /** The sanitized document, or null when it is not an acceptable SVG. */
    public static function sanitize(string $text): ?string
    {
        $doc = self::parse($text);
        if ($doc === null) {
            return null;
        }
        $root = $doc->documentElement;
        self::clean($root);
        $doc->encoding = 'UTF-8';
        $xml = $doc->saveXML($root);
        if ($xml === false || self::parse($xml) === null) {
            return null;
        }

        return $xml;
    }

    public static function parse(string $text): ?DOMDocument
    {
        $previous = libxml_use_internal_errors(true);
        try {
            $doc = new DOMDocument;
            $ok = $doc->loadXML($text, LIBXML_NONET | LIBXML_COMPACT | LIBXML_PARSEHUGE);
            libxml_clear_errors();
            if (! $ok || $doc->documentElement === null) {
                return null;
            }
            $root = $doc->documentElement;
            if ($root->namespaceURI !== self::SVG_NS || $root->localName !== 'svg' || $root->prefix !== '') {
                return null;
            }

            return $doc;
        } finally {
            libxml_use_internal_errors($previous);
        }
    }

    /** Depth-first, iteratively (the pre-scan bounds the depth anyway). */
    private static function clean(DOMElement $root): void
    {
        $stack = [$root];
        while ($stack !== []) {
            $el = array_pop($stack);
            self::attributes($el);
            self::namespaces($el);
            $children = [];
            foreach ($el->childNodes as $child) {
                $children[] = $child;
            }
            foreach ($children as $child) {
                self::child($el, $child, $stack);
            }
        }
    }

    /** @param  list<DOMElement>  $stack */
    private static function child(DOMElement $parent, DOMNode $child, array &$stack): void
    {
        switch ($child->nodeType) {
            case XML_ELEMENT_NODE:
                /** @var DOMElement $child */
                if ($child->namespaceURI !== self::SVG_NS || $child->prefix !== '') {
                    $parent->removeChild($child);

                    return;
                }
                $lc = strtolower($child->localName);
                if (! in_array($lc, self::ALLOWED_TAGS, true) || in_array($lc, self::FORBID_TAGS, true)) {
                    // KEEP_CONTENT: the children of a removed element stay (and are sanitized), unless its content is
                    // forbidden as a whole.
                    if (! in_array($lc, self::FORBID_CONTENTS, true)) {
                        $moved = [];
                        foreach ($child->childNodes as $grandchild) {
                            $moved[] = $grandchild;
                        }
                        foreach ($moved as $grandchild) {
                            $parent->insertBefore($grandchild, $child);
                            self::child($parent, $grandchild, $stack);
                        }
                    }
                    $parent->removeChild($child);

                    return;
                }
                $stack[] = $child;

                return;
            case XML_TEXT_NODE:
                return;
            case XML_CDATA_SECTION_NODE:
                $parent->replaceChild($parent->ownerDocument->createTextNode((string) $child->nodeValue), $child);

                return;
            default: // comments, processing instructions, entity references…
                $parent->removeChild($child);
        }
    }

    private static function attributes(DOMElement $el): void
    {
        $lcTag = strtolower($el->localName);
        $attrs = [];
        foreach ($el->attributes as $attr) {
            $attrs[] = $attr;
        }
        foreach (array_reverse($attrs) as $attr) {
            /** @var DOMAttr $attr */
            $name = $attr->nodeName;
            $lcName = strtolower($name);
            $initial = (string) $attr->value;
            $value = self::jsTrim($initial);
            $keep = true;
            // ── the AgroTrace hook (uponSanitizeAttribute) ──
            if ($lcName === 'style') {
                $value = self::cleanStyle($value);
                $keep = $value !== '';
            } elseif (in_array($lcName, self::CSS_ATTRIBUTES, true) && ! self::safeCssAttribute($value)) {
                $keep = false;
            } else {
                if ($lcName === 'href' || $lcName === 'xlink:href') {
                    $dataImage = $lcTag === 'image' && self::isRasterDataUri($value);
                    if (! self::isLocalRef($value) && ! $dataImage) {
                        $keep = false;
                    }
                }
                if (! self::urlTargetsLocal($value)) {
                    $keep = false;
                }
                if (self::containsCi($value, '@import') || self::containsCi($value, 'javascript:') || self::hasExpression($value)) {
                    $keep = false;
                }
            }
            // ── DOMPurify ──
            if (self::unsafeForXml($value) || ($lcName === 'attributename' && str_contains($value, 'href'))) {
                $keep = false;
            }
            if ($keep && ! self::validAttribute($lcTag, $lcName, $value)) {
                $keep = false;
            }
            if (! $keep) {
                $el->removeAttributeNode($attr);

                continue;
            }
            if ($value !== $initial) {
                $ns = $attr->namespaceURI;
                $ns === null ? $el->setAttribute($name, $value) : $el->setAttributeNS($ns, $name, $value);
            }
        }
    }

    /** Namespace declarations other than the default SVG one and `xmlns:xlink` are dropped (DOMPurify's allowlist). */
    private static function namespaces(DOMElement $el): void
    {
        $xpath = new DOMXPath($el->ownerDocument);
        foreach ($xpath->query('namespace::*', $el) ?: [] as $ns) {
            $prefix = $ns->prefix ?? '';
            $uri = (string) $ns->nodeValue;
            if ($prefix === 'xml' || $prefix === '' || ($prefix === 'xlink' && $uri === self::XLINK_NS)) {
                continue;
            }
            // Only a declaration made on this very element can be removed here.
            if ($el->hasAttribute("xmlns:{$prefix}")) {
                $el->removeAttributeNS($uri, $prefix);
            }
        }
    }

    private static function validAttribute(string $lcTag, string $lcName, string $value): bool
    {
        $allowed = in_array($lcName, self::ALLOWED_ATTR, true);
        if (self::isDataAttr($lcName) || self::isAriaAttr($lcName)) {
            return true;
        }
        if (! $allowed) {
            return false;
        }
        if (in_array($lcName, self::URI_SAFE, true)) {
            return true;
        }
        $compact = self::stripAttrWhitespace($value);
        if (self::isAllowedUri($compact)) {
            return true;
        }
        if (in_array($lcName, ['src', 'xlink:href', 'href'], true) && str_starts_with($value, 'data:')
            && in_array($lcTag, ['audio', 'video', 'img', 'source', 'image', 'track'], true)) {
            return true;
        }

        return $value === '';
    }

    /** DOMPurify IS_ALLOWED_URI: `^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))`i */
    private static function isAllowedUri(string $v): bool
    {
        if ($v === '') {
            return false;
        }
        $lower = strtolower($v);
        foreach (['http:', 'https:', 'ftp:', 'ftps:', 'mailto:', 'tel:', 'callto:', 'sms:', 'cid:', 'xmpp:', 'matrix:'] as $scheme) {
            if (str_starts_with($lower, $scheme)) {
                return true;
            }
        }
        $c = $lower[0];
        if ($c < 'a' || $c > 'z') {
            return true;
        }
        $run = strspn($lower, 'abcdefghijklmnopqrstuvwxyz+.-');
        if ($run === strlen($lower)) {
            return true;
        }

        return $lower[$run] !== ':';
    }

    private static function stripAttrWhitespace(string $v): string
    {
        $out = preg_replace(Ecma::compile('[\u0000-   ᠎ -  　]'), '', $v);

        return is_string($out) ? $out : $v;
    }

    private static function isDataAttr(string $lcName): bool
    {
        return str_starts_with($lcName, 'data-') && strlen($lcName) > 5
            && Ecma::test(Ecma::compile('^data-[\-\w.·-￿]+$'), $lcName);
    }

    private static function isAriaAttr(string $lcName): bool
    {
        return str_starts_with($lcName, 'aria-') && strlen($lcName) > 5 && strspn($lcName, 'abcdefghijklmnopqrstuvwxyz0123456789_-', 5) === strlen($lcName) - 5;
    }

    /** SAFE_FOR_XML: `((--!?|])>)|</(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)`i */
    private static function unsafeForXml(string $v): bool
    {
        if (str_contains($v, '-->') || str_contains($v, '--!>') || str_contains($v, ']>')) {
            return true;
        }
        $lower = strtolower($v);
        foreach (['style', 'script', 'title', 'xmp', 'textarea', 'noscript', 'iframe', 'noembed', 'noframes'] as $t) {
            if (str_contains($lower, "</{$t}")) {
                return true;
            }
        }

        return false;
    }

    /** P17: the declarations of a `style` attribute that are allowlisted presentation properties with plain values. */
    public static function cleanStyle(string $style): string
    {
        $kept = [];
        foreach (explode(';', $style) as $decl) {
            $colon = strpos($decl, ':');
            if ($colon === false) {
                continue;
            }
            $prop = strtolower(self::jsTrim(substr($decl, 0, $colon)));
            $value = self::jsTrim(substr($decl, $colon + 1));
            $isFont = str_starts_with($prop, 'font-') && strlen($prop) > 5 && strspn($prop, 'abcdefghijklmnopqrstuvwxyz-', 5) === strlen($prop) - 5;
            if (! in_array($prop, self::STYLE_PROPERTIES, true) && ! $isFont) {
                continue;
            }
            if ($value === '' || self::styleValueForbidden($value) || strpbrk($value, '<>"') !== false) {
                continue;
            }
            $kept[] = "{$prop}: {$value}";
        }

        return implode('; ', $kept);
    }

    /** `url\s*\(|\\|image-set|@|expression\s*\(`i */
    private static function styleValueForbidden(string $v): bool
    {
        return self::hasCall($v, 'url') || str_contains($v, '\\') || self::containsCi($v, 'image-set')
            || str_contains($v, '@') || self::hasExpression($v);
    }

    /** P20: no `\`, no `expression(`, and every `url(` a plain `url(#id)`. */
    public static function safeCssAttribute(string $value): bool
    {
        if (str_contains($value, '\\') || self::hasExpression($value)) {
            return false;
        }

        return self::countCalls($value, 'url') === self::countLocalUrls($value);
    }

    private static function isLocalRef(string $v): bool
    {
        return str_starts_with(ltrim($v, " \t\n\r\f\v"), '#');
    }

    /** `^\s*data:image/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$`i */
    private static function isRasterDataUri(string $v): bool
    {
        $s = strtolower(ltrim($v, " \t\n\r\f\v"));
        foreach (['png', 'jpeg', 'gif', 'webp'] as $t) {
            $prefix = "data:image/{$t};base64,";
            if (str_starts_with($s, $prefix)) {
                $rest = substr($s, strlen($prefix));

                return strspn($rest, "abcdefghijklmnopqrstuvwxyz0123456789+/= \t\n\r\f\v") === strlen($rest);
            }
        }

        return false;
    }

    /**
     * Whether the target of every `url\s*\(\s*(['"]?)([^'")]*)` in $v (case-insensitive, global) is a local reference
     * (`^\s*#`), as the hook's matchAll reads them. Linear (P18): like matchAll, the search resumes after the whole
     * match (`url(url(url(…` is one match), and each target is judged in place, never copied.
     */
    private static function urlTargetsLocal(string $v): bool
    {
        $lower = strtolower($v);
        $n = strlen($v);
        $at = 0;
        while (($p = strpos($lower, 'url', $at)) !== false) {
            $j = $p + 3;
            $j += strspn($v, " \t\n\r\f\v", $j);
            if ($j < $n && $v[$j] === '(') {
                $j++;
                $j += strspn($v, " \t\n\r\f\v", $j);
                if ($j < $n && ($v[$j] === '"' || $v[$j] === "'")) {
                    $j++;
                }
                $len = strcspn($v, "'\")", $j);
                $lead = strspn($v, " \t\n\r\f\v", $j, $len);
                if ($lead === $len || $v[$j + $lead] !== '#') {
                    return false;
                }
                $at = $j + $len;

                continue;
            }
            $at = $p + 3;
        }

        return true;
    }

    private static function hasCall(string $v, string $fn): bool
    {
        return self::countCalls($v, $fn) > 0;
    }

    /** Occurrences of `<fn>\s*\(` (case-insensitive). */
    private static function countCalls(string $v, string $fn): int
    {
        $lower = strtolower($v);
        $count = 0;
        $at = 0;
        while (($p = strpos($lower, $fn, $at)) !== false) {
            $j = $p + strlen($fn);
            $j += strspn($v, " \t\n\r\f\v", $j);
            if (($v[$j] ?? '') === '(') {
                $count++;
            }
            $at = $p + strlen($fn);
        }

        return $count;
    }

    /** Occurrences of `url\(\s*#[A-Za-z_][\w.-]*\s*\)` (case-insensitive). */
    private static function countLocalUrls(string $v): int
    {
        $lower = strtolower($v);
        $count = 0;
        $at = 0;
        while (($p = strpos($lower, 'url(', $at)) !== false) {
            $j = $p + 4;
            $j += strspn($v, " \t\n\r\f\v", $j);
            if (($v[$j] ?? '') === '#' && strspn($v, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_', $j + 1, 1) === 1) {
                $k = $j + 2 + strspn($v, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-', $j + 2);
                $k += strspn($v, " \t\n\r\f\v", $k);
                if (($v[$k] ?? '') === ')') {
                    $count++;
                }
            }
            $at = $p + 4;
        }

        return $count;
    }

    private static function hasExpression(string $v): bool
    {
        return self::hasCall($v, 'expression');
    }

    private static function containsCi(string $v, string $needle): bool
    {
        return stripos($v, $needle) !== false;
    }

    private static function jsTrim(string $s): string
    {
        $t = trim($s, " \t\n\r\v\f");
        if ($t === '' || (ord($t[0]) < 0x80 && ord($t[strlen($t) - 1]) < 0x80)) {
            return $t;
        }
        // Offsets and a set lookup per character, one copy at the end: linear however long the white space (P18).
        static $set = null;
        $set ??= array_flip(preg_split('//u', self::JS_SPACE, -1, PREG_SPLIT_NO_EMPTY) ?: []);
        $start = 0;
        $end = strlen($t);
        while ($start < $end) {
            $b = ord($t[$start]);
            $len = $b < 0x80 ? 1 : ($b < 0xE0 ? 2 : ($b < 0xF0 ? 3 : 4));
            if (! isset($set[substr($t, $start, $len)])) {
                break;
            }
            $start += $len;
        }
        while ($end > $start) {
            $k = $end - 1;
            while ($k > $start && (ord($t[$k]) & 0xC0) === 0x80) {
                $k--;
            }
            if (! isset($set[substr($t, $k, $end - $k)])) {
                break;
            }
            $end = $k;
        }

        return substr($t, $start, $end - $start);
    }
}
