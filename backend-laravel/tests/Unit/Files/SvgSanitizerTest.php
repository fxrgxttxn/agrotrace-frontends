<?php

/*
 * The DOM stage of SVG sanitizing (P15, P17, P20) — the cases of Express test/files-units.test.ts: hostile documents
 * (also ones the pre-scan would refuse: defence in depth), an ordinary logo kept intact, url(#id) paint kept, the
 * style/CSS-attribute rules, documents that are no safe SVG refused; and the full path through the sandbox lane.
 */

use App\Infrastructure\Svg\SvgDom;
use App\Infrastructure\Svg\SvgSanitizer;
use Tests\TestCase;

uses(TestCase::class);

it('removes scripts, handlers, foreignObject, style elements, animation, external references', function () {
    $out = SvgDom::sanitize(<<<'SVG'
        <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()">
          <script>alert(1)</script><style>@import url(http://e/x.css)</style>
          <foreignObject><body xmlns="http://www.w3.org/1999/xhtml" onload="y()"/></foreignObject>
          <a href="javascript:alert(1)"><circle r="1" onclick="z()"/></a>
          <a xlink:href="https://evil.example/"><rect width="1" height="1"/></a>
          <image href="https://evil.example/t.png"/><image href="data:image/png;base64,iVBORw0KGgo="/>
          <use href="https://evil.example/s.svg#i"/><rect style="fill:url(https://e/x)" filter="url(#f)" mask="url(http://e/m)"/>
          <rect style="fill: #D9B650; background-image: url(https://e/y)" fill="u&#x5c;72l(x)" stroke="&#117;rl(http://e/z)"/>
          <set attributeName="onclick" to="alert(1)"/><animate attributeName="href" to="javascript:alert(1)"/>
        </svg>
        SVG);
    expect($out)->not->toBeNull();
    foreach (['script', 'onload', 'onclick', 'javascript', 'evil.example', 'foreignObject', '<style', '@import',
        'http://e', 'https://e', '<set', '<animate', 'background', '\\', 'stroke='] as $bad) {
        expect($out)->not->toContain($bad);
    }
    expect($out)->toContain('filter="url(#f)"');
    expect($out)->toContain('style="fill: #D9B650"');
    expect($out)->toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect($out)->toStartWith('<svg xmlns="http://www.w3.org/2000/svg"');
});

it('keeps an ordinary logo intact (case-sensitive SVG names, text, url(#id) paint)', function () {
    $out = SvgDom::sanitize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="9" height="9"/></clipPath></defs><rect fill="url(#g)" clip-path="url(#c)" width="96" height="96"/><text x="1" y="2">Лого &amp; Ко</text></svg>');
    foreach (['viewBox="0 0 96 96"', '<linearGradient id="g">', '<clipPath id="c">', 'fill="url(#g)"', 'clip-path="url(#c)"', 'Лого &amp; Ко'] as $kept) {
        expect($out)->toContain($kept);
    }
});

it('refuses what is not a safe, well-formed SVG document', function () {
    expect(SvgDom::sanitize('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'))->toBeNull();
    expect(SvgDom::sanitize('<svg><rect/></svg>'))->toBeNull();
    expect(SvgDom::sanitize('<s:svg xmlns:s="http://www.w3.org/2000/svg"/>'))->toBeNull();
    expect(SvgDom::sanitize('<html xmlns="http://www.w3.org/1999/xhtml"/>'))->toBeNull();
    expect(SvgDom::sanitize('<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>'))->toBeNull();
});

it('style keeps allowlisted presentation properties with plain values only', function () {
    expect(SvgDom::cleanStyle('fill: #fff; stroke:red;font-family: Onest, sans-serif ;opacity:.5'))
        ->toBe('fill: #fff; stroke: red; font-family: Onest, sans-serif; opacity: .5');
    expect(SvgDom::cleanStyle('fill:url(#g)'))->toBe('');
    expect(SvgDom::cleanStyle('background:url(http://e/x); fill:red'))->toBe('fill: red');
    expect(SvgDom::cleanStyle('fill: \75 rl(x); stroke: image-set("a.png" 1x); font-family: @x; display:none'))->toBe('display: none');
    expect(SvgDom::cleanStyle('fill: expression(alert(1)); stroke: blue'))->toBe('stroke: blue');
    expect(SvgDom::cleanStyle('behavior: url(x.htc); position: fixed'))->toBe('');
});

it('CSS-parsed attributes: no backslash, only url(#id)', function () {
    expect(SvgDom::safeCssAttribute('url(#g)'))->toBeTrue();
    expect(SvgDom::safeCssAttribute('url( #grad-1 ) red'))->toBeTrue();
    expect(SvgDom::safeCssAttribute('#D9B650'))->toBeTrue();
    expect(SvgDom::safeCssAttribute('url(http://e/x)'))->toBeFalse();
    expect(SvgDom::safeCssAttribute("url('#g')"))->toBeFalse();
    expect(SvgDom::safeCssAttribute('u\72l(http://e/x)'))->toBeFalse();
    expect(SvgDom::safeCssAttribute('URL(#g) url(//e/x)'))->toBeFalse();
    expect(SvgDom::safeCssAttribute('expression(alert(1))'))->toBeFalse();
});

it('sanitizes through the sandbox lane: the hostile fixture of tests/api comes back clean', function () {
    config(['agrotrace.sandbox.dir' => sys_get_temp_dir().'/agrotrace-lanes-test-'.getmypid()]);
    $hostile = (string) file_get_contents(dirname(base_path()).'/tests/api/fixtures/logo-hostile.svg');
    $out = SvgSanitizer::sanitize($hostile, ['image/svg+xml']);
    expect($out)->toStartWith('<svg');
    expect($out)->toContain('Безопасный текст');
    expect($out)->toContain('id="keep"');
    foreach (['onload', 'javascript:', 'evil.example', 'mask=', '\\'] as $bad) {
        expect(strtolower($out))->not->toContain($bad);
    }
});
