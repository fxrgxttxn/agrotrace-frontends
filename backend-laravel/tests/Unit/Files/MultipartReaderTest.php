<?php

/*
 * multipart/form-data (P14, P17, P20; Express http/multipart.ts over busboy): one `file` part; the inclusive limit;
 * required / duplicate / unknownField / maxLength / `_root invalid`; the base name with quoted-string escapes undone
 * and `%22` kept; 413 after the form errors.
 */

use App\Http\Multipart\MultipartReader;
use App\Http\Problem\Problem;

const MP_BOUNDARY = '----agrotraceTestBoundary';

/** @param  list<array{name: string, filename?: string, raw?: string, data: string}>  $parts */
function mpBody(array $parts, bool $close = true): string
{
    $out = '';
    foreach ($parts as $p) {
        $head = '--'.MP_BOUNDARY."\r\nContent-Disposition: form-data; name=\"{$p['name']}\"";
        if (isset($p['raw'])) {
            $head .= "; filename={$p['raw']}";
        } elseif (isset($p['filename'])) {
            $head .= '; filename="'.str_replace('"', '%22', $p['filename']).'"';
        }
        $out .= $head."\r\nContent-Type: application/octet-stream\r\n\r\n".$p['data']."\r\n";
    }

    return $out.($close ? '--'.MP_BOUNDARY."--\r\n" : '');
}

function mpErrors(string $body, int $max = 10): array|int|null
{
    try {
        MultipartReader::parse($body, MP_BOUNDARY, $max);

        return null;
    } catch (Problem $p) {
        return $p->status === 400 ? $p->errors : $p->status;
    }
}

it('reads the one file part; the limit is inclusive', function () {
    $u = MultipartReader::parse(mpBody([['name' => 'file', 'filename' => 'a.png', 'data' => '0123456789']]), MP_BOUNDARY, 10);
    expect([$u->bytes, $u->originalName, $u->size])->toBe(['0123456789', 'a.png', 10]);
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => 'a.png', 'data' => '01234567890']])))->toBe(413);
});

it('form errors: required, duplicate, unknownField, empty file; they come before 413', function () {
    expect(mpErrors(mpBody([])))->toBe(['file' => ['validation.required']]);
    expect(mpErrors(mpBody([['name' => 'file', 'data' => 'text']])))->toBe(['file' => ['validation.required']]);
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => 'a', 'data' => '']])))->toBe(['file' => ['validation.required']]);
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => 'a', 'data' => 'x'], ['name' => 'caption', 'data' => 'hello']])))
        ->toBe(['caption' => ['validation.unknownField']]);
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => 'a', 'data' => 'x'], ['name' => 'image', 'filename' => 'b', 'data' => 'y']])))
        ->toBe(['image' => ['validation.unknownField']]);
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => 'a', 'data' => 'x'], ['name' => 'file', 'filename' => 'b', 'data' => 'y']])))
        ->toBe(['file' => ['validation.duplicate']]);
    expect(mpErrors(mpBody([['name' => 'file', 'data' => 'text'], ['name' => 'file', 'filename' => 'b', 'data' => 'y']])))
        ->toBe(['file' => ['validation.duplicate']]);
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => 'a', 'data' => str_repeat('x', 20)], ['name' => 'extra', 'data' => '1']])))
        ->toBe(['extra' => ['validation.unknownField']]);
});

it('a malformed body is _root invalid; more than 20 parts too', function () {
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => 'a', 'data' => 'x']], false)))->toBe(['_root' => ['validation.invalid']]);
    expect(mpErrors('garbage without a boundary'))->toBe(['_root' => ['validation.invalid']]);
    $many = array_fill(0, 21, ['name' => 'f', 'data' => '1']);
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => 'a', 'data' => 'x'], ...$many])))->toHaveKey('_root');
});

it('the stored name is the base name; quoted-string escapes undone, %22 kept, 255 code points at most', function () {
    $name = fn (string $raw) => MultipartReader::parse(mpBody([['name' => 'file', 'raw' => $raw, 'data' => 'x']]), MP_BOUNDARY, 10)->originalName;
    expect($name('"reports/2026/photo.png"'))->toBe('photo.png');
    expect($name('"C:\\\\fakepath\\\\Фото.png"'))->toBe('Фото.png');
    expect($name('"say \\"cheese\\".png"'))->toBe('say "cheese".png');
    expect($name('"quote%22and\'apos(1).png"'))->toBe('quote%22and\'apos(1).png');
    expect($name('".."'))->toBe('');
    expect($name("\"bad\xFFbyte.png\""))->toBe("bad\u{FFFD}byte.png");
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => str_repeat('я', 256), 'data' => 'x']])))->toBe(['file' => ['validation.maxLength']]);
    expect(mpErrors(mpBody([['name' => 'file', 'filename' => str_repeat('я', 255), 'data' => 'x']])))->toBeNull();
});

it('reads the boundary parameter, quoted or not', function () {
    expect(MultipartReader::boundary('multipart/form-data; boundary=abc'))->toBe('abc');
    expect(MultipartReader::boundary('multipart/form-data; charset=utf-8; boundary="a b"'))->toBe('a b');
    expect(MultipartReader::boundary('multipart/form-data'))->toBeNull();
});
