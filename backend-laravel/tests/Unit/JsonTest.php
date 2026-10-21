<?php

/*
 * Json (L9, Review Focus 8): `{}` stays an object and `[]` an array through decode → encode, numbers print as
 * JavaScript prints them (1.0 → 1), text as JSON.stringify writes it, jsonb objects read back from PostgreSQL keep
 * their (empty) objects.
 */

use App\Support\Json;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

uses(TestCase::class);

it('keeps {} and [] apart through decode and encode', function (string $json) {
    expect(Json::encode(Json::decode($json)))->toBe($json);
})->with([
    '{}', '[]', '{"a":{}}', '{"a":[]}', '[{}]', '{"params":{},"errors":{"_root":["validation.invalid"]}}',
    '{"diff":{"name":[null,"x"]}}', '{"a":{"b":{"c":{}}}}',
]);

it('prints numbers as JavaScript does', function () {
    expect(Json::encode(1.0))->toBe('1');
    expect(Json::encode(Json::decode('1.0')))->toBe('1');
    expect(Json::encode(Json::decode('{"x":2.50}')))->toBe('{"x":2.5}');
    expect(Json::encode(0.1))->toBe('0.1');
    expect(Json::encode(12))->toBe('12');
});

it('writes text as JSON.stringify: no escaped slashes, unicode or line separators', function () {
    expect(Json::encode('/api/v1/files/x'))->toBe('"/api/v1/files/x"');
    expect(Json::encode('Партия №1'))->toBe('"Партия №1"');
    expect(Json::encode("a\u{2028}b"))->toBe("\"a\u{2028}b\"");
    expect(Json::encode("q\"\\\n"))->toBe('"q\"\\\\\n"');
});

it('builds objects from associative arrays, also when empty', function () {
    expect(Json::encode(Json::obj([])))->toBe('{}');
    expect(Json::encode(Json::obj(['a' => ['b' => 1], 'l' => [1, 2], 'e' => []])))->toBe('{"a":{"b":1},"l":[1,2],"e":[]}');
    expect(Json::encode(Json::obj(['0' => 'x'])))->toBe('{"0":"x"}');
});

it('refuses malformed JSON', function () {
    expect(fn () => Json::decode('{"a":'))->toThrow(JsonException::class);
});

it('keeps the objects of a jsonb value read from PostgreSQL', function () {
    $this->requireDatabase();
    $row = DB::selectOne(<<<'SQL'
        SELECT '{"diff":{},"payload":{"data":{"ids":[]}},"n":1.0}'::jsonb AS doc
        SQL);
    $doc = Json::decode($row->doc);
    expect($doc->diff)->toBeInstanceOf(stdClass::class);
    expect(Json::encode($doc))->toBe('{"n":1,"diff":{},"payload":{"data":{"ids":[]}}}');
})->group('integration');
