<?php

/*
 * The CSV import reader (R58; Express sheet.ts parseCsv/toSheet): `;`, BOM, RFC 4180 quotes, LF/CRLF record ends, a
 * lone CR as data, format errors before tooManyRows, NUL → 415, invalid UTF-8 → 400; bounded memory and time on
 * adversarial 5 MiB inputs.
 */

use App\Http\Problem\Problem;
use App\Infrastructure\Import\CsvReader;
use Tests\TestCase;

uses(TestCase::class);

function csvOutcome(string $bytes, ?int $width = null): mixed
{
    try {
        $s = CsvReader::read($bytes, $width);

        return ['header' => $s->header, 'rows' => $s->rows];
    } catch (Problem $p) {
        return $p->status.' '.json_encode($p->errors ?? $p->params);
    }
}

it('header, records with their numbers, empty records skipped but counted', function () {
    expect(csvOutcome("\xEF\xBB\xBFa;b\r\n1;2\r\n\r\n;\r\n3;4"))->toBe([
        'header' => ['a', 'b'],
        'rows' => [['number' => 2, 'cells' => ['1', '2']], ['number' => 5, 'cells' => ['3', '4']]],
    ]);
});

it('quotes: separators, line breaks and "" inside; a quote inside an unquoted field is data; a lone CR is data', function () {
    expect(csvOutcome("h\n\"a;b\nc\"\"d\";x\"y\na\rb;\"\"\n")['rows'])->toBe([
        ['number' => 2, 'cells' => ["a;b\nc\"d", 'x"y']],
        ['number' => 3, 'cells' => ["a\rb", '']],
    ]);
});

it('a trailing separator is one more empty field; the final line break starts no record', function () {
    expect(csvOutcome("h\na;\n")['rows'])->toBe([['number' => 2, 'cells' => ['a', '']]]);
    expect(csvOutcome("h\na;")['rows'])->toBe([['number' => 2, 'cells' => ['a', '']]]);
    expect(csvOutcome(''))->toBe(['header' => null, 'rows' => []]);
    expect(csvOutcome("\xEF\xBB\xBF"))->toBe(['header' => null, 'rows' => []]);
});

it('format errors: an unclosed quote, a character after a closing quote (a lone CR too) → 400 format', function (string $text) {
    expect(csvOutcome($text))->toBe('400 {"file":["validation.import.format"]}');
})->with([
    'unclosed' => ["h\n\"abc\n"],
    'after quote' => ["h\n\"a\"b;c\n"],
    'lone CR after quote' => ["h\n\"a\"\rb\n"],
    'invalid UTF-8' => ["h\n\xC3\x28;x\n"],
]);

it('a NUL byte → 415 {allowed}', function () {
    expect(csvOutcome("h\nA\0;B\n"))->toStartWith('415');
});

it('10 000 data rows read, the 10 001st → tooManyRows — but a format error anywhere wins', function () {
    $rows = fn (int $n) => "h\n".str_repeat("x\n", $n);
    expect(csvOutcome($rows(10000)."\n\n")['rows'])->toHaveCount(10000);
    expect(csvOutcome($rows(10001)))->toBe('400 {"file":["validation.import.tooManyRows"]}');
    expect(csvOutcome($rows(10001)."\"open\n"))->toBe('400 {"file":["validation.import.format"]}');
});

it('bounded to a width: a record of another width keeps no fields (null), an empty one is still skipped', function () {
    expect(csvOutcome("a;b\n1;2\n1;2;3\n1\n;;;;\n", 2)['rows'])->toBe([
        ['number' => 2, 'cells' => ['1', '2']],
        ['number' => 3, 'cells' => null],
        ['number' => 4, 'cells' => null],
    ]);
    expect(csvOutcome("a;b;c;d\n", 2)['header'])->toBe(['a', 'b', 'c']);
});

it('adversarial 5 MiB inputs: bounded time and memory', function (string $text) {
    $before = memory_get_usage();
    $started = microtime(true);
    csvOutcome($text, 3);
    expect(microtime(true) - $started)->toBeLessThan(3.0);
    expect(memory_get_peak_usage() - $before)->toBeLessThan(64 * 1024 * 1024);
})->with([
    'one record of separators' => fn () => "h\n".str_repeat(';', 5 * 1024 * 1024),
    'one record of tiny fields' => fn () => "h\n".str_repeat('a;', 2 * 1024 * 1024),
    'quoted empty fields' => fn () => "h\n".str_repeat('"";', 1700000),
    'quoted fields with escapes' => fn () => "h\n".str_repeat('"a""b";', 600000),
    'many short records' => fn () => str_repeat("x\n", 2500000),
]);
