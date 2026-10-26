<?php

/*
 * ComplaintDecision (packages/validation/src/complaints.ts, a Zod discriminatedUnion) with Express's decisionRules
 * merged over the schema errors per field (`{...errors, ...rules}`, P42, P44), and PublicComplaintRequest with the
 * publicCode pattern in the same 400 — the exact error bodies, in order.
 */

use App\Http\Problem\Problem;
use App\Http\Validation\Schemas\ComplaintSchemas;
use App\Support\Json;
use Tests\TestCase;

uses(TestCase::class);

const CS_UUID = '00000000-0000-4000-8000-000000000000';

/** @return array<string, list<string>>|array{ok: mixed} */
function decisionErrors(string $json): array
{
    try {
        return ['ok' => ComplaintSchemas::parseDecision(Json::decode($json))];
    } catch (Problem $p) {
        return $p->errors ?? [];
    }
}

it('reports decision errors as Express does', function (string $json, array $errors) {
    expect(decisionErrors($json))->toBe($errors);
})->with([
    'empty object' => ['{}', ['decision' => ['validation.required']]],
    'array' => ['[]', ['_root' => ['validation.type']]],
    'null' => ['null', ['_root' => ['validation.type']]],
    'unknown decision' => ['{"decision":"MAYBE","comment":"x"}', ['decision' => ['validation.enum']]],
    'decision a number with labOrgId' => ['{"decision":1,"labOrgId":"x"}', ['decision' => ['validation.enum']]],
    'decision null' => ['{"decision":null}', ['decision' => ['validation.enum']]],
    'REJECT with labOrgId' => ['{"decision":"REJECT","comment":"x","labOrgId":"'.CS_UUID.'"}', ['labOrgId' => ['validation.notAllowed']]],
    'REJECT with blockUpstream' => ['{"decision":"REJECT","comment":"x","blockUpstream":true}', ['blockUpstream' => ['validation.notAllowed']]],
    'LAB_TEST without labOrgId' => ['{"decision":"LAB_TEST","comment":"x"}', ['labOrgId' => ['validation.required']]],
    'LAB_TEST with blockUpstream' => ['{"decision":"LAB_TEST","comment":"x","labOrgId":"'.CS_UUID.'","blockUpstream":false}', ['blockUpstream' => ['validation.notAllowed']]],
    'LAB_TEST bad uuid, no comment' => ['{"decision":"LAB_TEST","labOrgId":"x"}', ['comment' => ['validation.required'], 'labOrgId' => ['validation.uuid']]],
    'RECALL whitespace comment' => ['{"decision":"RECALL","comment":"   "}', ['comment' => ['validation.pattern']]],
    'RECALL with labOrgId and an extra field' => ['{"decision":"RECALL","comment":"x","labOrgId":"x","z":1}', ['labOrgId' => ['validation.notAllowed'], 'z' => ['validation.unknownField']]],
    'RECALL blockUpstream null' => ['{"decision":"RECALL","comment":"x","blockUpstream":null}', ['blockUpstream' => ['validation.type']]],
    'REJECT extra field' => ['{"decision":"REJECT","comment":"","extra":1}', ['comment' => ['validation.required', 'validation.pattern'], 'extra' => ['validation.unknownField']]],
]);

it('parses the variants; blockUpstream defaults to false', function () {
    expect(decisionErrors('{"decision":"RECALL","comment":"Отзыв"}'))->toBe(['ok' => ['decision' => 'RECALL', 'comment' => 'Отзыв', 'blockUpstream' => false]])
        ->and(decisionErrors('{"decision":"LAB_TEST","comment":"x","labOrgId":"'.CS_UUID.'"}'))
        ->toBe(['ok' => ['decision' => 'LAB_TEST', 'comment' => 'x', 'labOrgId' => CS_UUID]]);
});

it('createPublicComplaint: the schema errors, then publicCode, in one 400', function () {
    try {
        ComplaintSchemas::parsePublic(Json::decode('{"text":"коротко","altcha":"x","extra":1}'), ['publicCode' => ['validation.pattern']]);
        $errors = null;
    } catch (Problem $p) {
        $errors = $p->errors;
    }
    expect($errors)->toBe([
        'text' => ['validation.minLength'],
        'extra' => ['validation.unknownField'],
        'publicCode' => ['validation.pattern'],
    ]);
});
