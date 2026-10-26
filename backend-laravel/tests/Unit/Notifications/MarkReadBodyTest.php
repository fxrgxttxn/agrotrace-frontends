<?php

/*
 * markNotificationsRead's body (packages/validation MarkReadRequestSchema, a z.union of two strict objects): the first
 * option that parses wins; else the issues of the first option that matched the shape but failed a check (dirty);
 * else `_root validation.invalid`. Express (tests/api) agrees on the cases it covers; these pin the rest.
 */

use App\Http\Validation\Schemas\NotificationSchemas;
use Tests\TestCase;

uses(TestCase::class);

function markReadErrors(mixed $body): ?array
{
    $r = NotificationSchemas::markRead()->safeParse(json_decode(json_encode($body)));

    return $r['ok'] ? null : $r['issues']->fieldErrors();
}

it('accepts ids (1…100 distinct uuids, any case) or upToSeq (an integer ≥ 1)', function () {
    expect(markReadErrors(['ids' => ['B7C8D9E0-F1A2-4B3C-8D4E-5F6A7B8C9D0E']]))->toBeNull();
    expect(markReadErrors(['upToSeq' => 1]))->toBeNull();
    expect(markReadErrors(['upToSeq' => 5.0]))->toBeNull();
});

it('reports the first dirty option, else _root invalid', function () {
    expect(markReadErrors(['ids' => []]))->toBe(['ids' => ['validation.minItems']]);
    $u = 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e';
    expect(markReadErrors(['ids' => [$u, $u]]))->toBe(['ids' => ['validation.duplicate']]);
    expect(markReadErrors(['ids' => array_fill(0, 101, $u)]))->toHaveKey('ids');
    expect(markReadErrors(['ids' => ['nope']]))->toBe(['ids[0]' => ['validation.uuid']]);
    expect(markReadErrors(['upToSeq' => 0]))->toBe(['upToSeq' => ['validation.min']]);
    expect(markReadErrors([]))->toBe(['_root' => ['validation.invalid']]);
    expect(markReadErrors(['upToSeq' => 'x']))->toBe(['_root' => ['validation.invalid']]);
});
