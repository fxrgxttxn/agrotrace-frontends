<?php

/*
 * The streaming SVG pre-scan (P15, P18) — the cases of Express test/files-units.test.ts `scanSvg`: every limit at its
 * boundary, the element allowlist (case-sensitive, no prefixes), terminated constructs, and linear time on a
 * 10 000-deep document.
 */

use App\Http\Problem\Problem;
use App\Infrastructure\Svg\SvgSanitizer;
use App\Infrastructure\Svg\SvgScanner;
use Tests\TestCase;

uses(TestCase::class);

function svgWhy(string $s): ?string
{
    $r = SvgScanner::check($s);

    return $r === null ? null : ($r['tooComplex'] ? 'complex: ' : '').$r['why'];
}

function svgNested(int $n): string
{
    return '<svg xmlns="http://www.w3.org/2000/svg">'.str_repeat('<g>', $n - 1).str_repeat('</g>', $n - 1).'</svg>';
}

function svgFlat(int $n): string
{
    return '<svg xmlns="http://www.w3.org/2000/svg">'.str_repeat('<rect width="1" height="1"/>', $n - 1).'</svg>';
}

function svgAttrs(int $k, string $prefix = 'a'): string
{
    $out = '';
    for ($i = 0; $i < $k; $i++) {
        $out .= " {$prefix}{$i}=\"1\"";
    }

    return $out;
}

it('depth ≤ 64 and ≤ 5 000 elements pass, one more is too complex; no DOCTYPE; terminated constructs only', function () {
    expect(svgWhy(svgNested(64)))->toBeNull();
    expect(svgWhy(svgNested(65)))->toMatch('/complex: .*deep/');
    expect(svgWhy(svgFlat(5000)))->toBeNull();
    expect(svgWhy(svgFlat(5001)))->toBe('complex: too many elements');
    expect(svgWhy('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'))->toMatch('/declaration/');
    expect(svgWhy('<?xml version="1.0"?><!-- a > b --><svg a=">" b=\'/g\'/>'))->toBeNull();
    expect(svgWhy('<svg><![CDATA[<g><g>]]></svg>'))->toBeNull();
    expect(svgWhy('<svg><!-- never closed'))->toMatch('/comment/');
    expect(svgWhy('<svg a="unterminated>'))->toMatch('/attribute value/');
    expect(svgWhy('</g><svg/>'))->toMatch('/unbalanced/');
    expect(svgWhy('<svg><g>'))->toMatch('/unclosed/');
    expect(svgWhy('text only'))->toMatch('/no element/');
});

it('element allowlist: script, style, foreignObject, use, animation, prefixed or upper-case names → refused', function () {
    foreach (['script', 'style', 'foreignObject', 'use', 'set', 'animate', 'feImage', 'svg:rect', 'RECT'] as $el) {
        expect(svgWhy("<svg xmlns=\"http://www.w3.org/2000/svg\"><{$el}/></svg>"))->toMatch('/^element .* not allowed/');
    }
    expect(svgWhy('<s:svg xmlns:s="http://www.w3.org/2000/svg"/>'))->toMatch('/not allowed/');
    expect(svgWhy('<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="g"><stop/></linearGradient><feGaussianBlur/></svg>'))->toBeNull();
});

it('attribute limits: 100 per element, 20 000 in all, 32 namespace declarations, 64 KiB per value', function () {
    expect(svgWhy('<svg'.svgAttrs(100).'/>'))->toBeNull();
    expect(svgWhy('<svg'.svgAttrs(101).'/>'))->toBe('complex: too many attributes on an element');
    $rects = str_repeat('<rect'.svgAttrs(100).'/>', 200);
    expect(svgWhy("<svg>{$rects}</svg>"))->toBeNull();
    expect(svgWhy("<svg a=\"1\">{$rects}</svg>"))->toBe('complex: too many attributes');
    expect(svgWhy('<svg'.svgAttrs(32, 'xmlns:n').'/>'))->toBeNull();
    expect(svgWhy('<svg'.svgAttrs(33, 'xmlns:n').'/>'))->toBe('complex: too many namespace declarations');
    expect(svgWhy('<svg d="'.str_repeat('1', 65536).'"/>'))->toBeNull();
    expect(svgWhy('<svg d="'.str_repeat('1', 65537).'"/>'))->toBe('complex: attribute value too long');
    // UTF-16 code units, as in JavaScript: 40 000 Cyrillic letters are 80 000 bytes but 40 000 units.
    expect(svgWhy('<svg d="'.str_repeat('ж', 40000).'"/>'))->toBeNull();
    expect(svgWhy('<svg a="<b>"/>'))->toMatch('/`<` in an attribute value/');
    expect(svgWhy('<svg a=1/>'))->toMatch('/unquoted/');
    expect(svgWhy('<svg a/>'))->toMatch('/without a value/');
});

it('a 10 000-deep document is refused as too complex in milliseconds; invalid UTF-8 is refused (not complex)', function () {
    $allowed = ['image/svg+xml'];
    $started = microtime(true);
    try {
        SvgSanitizer::sanitize(svgNested(10000), $allowed);
        $this->fail('must be refused');
    } catch (Problem $p) {
        expect($p->status)->toBe(415);
        expect($p->params)->toBe(['allowed' => $allowed, 'reason' => 'svg-too-complex']);
    }
    expect(microtime(true) - $started)->toBeLessThan(0.2);
    expect(fn () => SvgSanitizer::sanitize("<svg\xFF>", $allowed))
        ->toThrow(fn (Problem $p) => expect($p->params)->toBe(['allowed' => $allowed]));
});

it('scans a 2 MB document of 5 000 elements linearly (well under a second)', function () {
    $path = str_repeat('M0 0 L1 1 ', 35);
    $heavy = '<svg xmlns="http://www.w3.org/2000/svg">'.str_repeat("<path fill=\"#000\" stroke=\"#fff\" opacity=\".5\" d=\"{$path}\"/>", 4900).'</svg>';
    $started = microtime(true);
    expect(svgWhy($heavy))->toBeNull();
    expect(microtime(true) - $started)->toBeLessThan(0.5);
});
