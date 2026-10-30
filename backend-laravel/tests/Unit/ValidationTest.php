<?php

/*
 * The Zod 3 port (L7): the 400 `errors` packages/validation gives the same bodies in Express — missing vs mistyped,
 * every string check, refinements after a dirty but not an aborted inner value, unknown keys after the shape's own
 * issues, minProperties, array bounds and duplicates, the INN checksum.
 */

use App\Http\Validation\Schemas\AuthSchemas;
use App\Http\Validation\Schemas\ProfileSchemas;
use App\Http\Validation\Z\Z;
use App\Support\Json;

function zErrors(object $schema, string $json): ?array
{
    $r = $schema->safeParse(Json::decode($json));

    return $r['ok'] ? null : $r['issues']->fieldErrors();
}

it('login: missing → required, unknown key → unknownField, bad email alone', function () {
    expect(zErrors(AuthSchemas::login(), '{"email":"a@b.ru"}'))->toBe(['password' => ['validation.required']]);
    expect(zErrors(AuthSchemas::login(), '{"email":"a@b.ru","password":"x","remember":true}'))->toBe(['remember' => ['validation.unknownField']]);
    expect(zErrors(AuthSchemas::login(), '{"email":"not-an-email","password":"x"}'))->toBe(['email' => ['validation.email']]);
    expect(zErrors(AuthSchemas::login(), '{"email":"","password":""}'))->toBe([
        'email' => ['validation.required', 'validation.email'],
        'password' => ['validation.required'],
    ]);
    expect(zErrors(AuthSchemas::login(), '[]'))->toBe(['_root' => ['validation.type']]);
    expect(zErrors(AuthSchemas::login(), '{"email":"A.B@Example.COM","password":"x"}'))->toBeNull();
});

it('registerOrganization: every schema error at once (PLATFORM, blank names, short password, extra)', function () {
    $errors = zErrors(AuthSchemas::registerOrganization(),
        '{"inn":"7707083893","type":"PLATFORM","name":"   ","regionCode":"33","extra":1,"admin":{"email":"a@b.ru","fullName":" \t","password":"short"}}');
    expect(array_keys($errors))->toBe(['type', 'name', 'admin.fullName', 'admin.password', 'extra']);
    expect($errors['admin.password'])->toBe(['validation.password.min']);
    expect($errors['name'])->toBe(['validation.pattern']);
});

it('INN: format and FNS checksum', function () {
    expect(Z::isValidInn('7707083893'))->toBeTrue();
    expect(Z::isValidInn('7707083894'))->toBeFalse();
    expect(Z::isValidInn('500100732259'))->toBeTrue();
    expect(zErrors(Z::object(['inn' => Z::inn()]), '{"inn":"12"}'))->toBe(['inn' => ['validation.inn.format', 'validation.inn.checksum']]);
});

it('updateMe: minProperties, pattern, required, phone format, unknown fields, null phone', function () {
    $s = ProfileSchemas::meUpdate();
    expect(zErrors($s, '{}'))->toBe(['_root' => ['validation.minProperties']]);
    expect(zErrors($s, '{"fullName":"   "}'))->toBe(['fullName' => ['validation.pattern']]);
    expect(zErrors($s, '{"fullName":""}'))->toBe(['fullName' => ['validation.required', 'validation.pattern']]);
    expect(zErrors($s, '{"phone":"89181234567"}'))->toBe(['phone' => ['validation.phone.format']]);
    expect(zErrors($s, '{"fullName":"Иванов","email":"x@y.ru"}'))->toBe(['email' => ['validation.unknownField']]);
    expect(zErrors($s, '{"phone":null,"roles":["ADMIN"]}'))->toBe(['roles' => ['validation.unknownField']]);
    expect($s->parse(Json::decode('{"phone":null}')))->toBe(['phone' => null]);
    expect(zErrors($s, '{"email":"x@y.ru"}'))->toBe(['email' => ['validation.unknownField'], '_root' => ['validation.minProperties']]);
});

it('userInvite and userPatch: types, enum, minItems, duplicates; an aborted element skips the refinement', function () {
    expect(zErrors(ProfileSchemas::userInvite(), '{}'))->toBe([
        'email' => ['validation.required'], 'fullName' => ['validation.required'],
        'roles' => ['validation.required'], 'isOrgAdmin' => ['validation.required'],
    ]);
    expect(zErrors(ProfileSchemas::userInvite(), '{"email":"not-an-email","fullName":" ","roles":[],"isOrgAdmin":"no"}'))->toBe([
        'email' => ['validation.email'], 'fullName' => ['validation.pattern'],
        'roles' => ['validation.minItems'], 'isOrgAdmin' => ['validation.type'],
    ]);
    expect(zErrors(ProfileSchemas::userInvite(), '{"email":"a@b.ru","fullName":"X","roles":["FARMER","FARMER"],"isOrgAdmin":false}'))
        ->toBe(['roles' => ['validation.duplicate']]);
    expect(zErrors(ProfileSchemas::userInvite(), '{"email":"a@b.ru","fullName":"X","roles":["BOSS","BOSS"],"isOrgAdmin":false}'))
        ->toBe(['roles[0]' => ['validation.enum'], 'roles[1]' => ['validation.enum']]);
    expect(zErrors(ProfileSchemas::userPatch(), '{"status":"INVITED"}'))->toBe(['status' => ['validation.enum']]);
    expect(zErrors(ProfileSchemas::userPatch(), '{}'))->toBe(['_root' => ['validation.minProperties']]);
});

it('numbers: integers, ranges, a JSON 1.0 is the integer 1', function () {
    $s = Z::object(['n' => Z::number()->int()->min(1)]);
    expect(zErrors($s, '{"n":1.5}'))->toBe(['n' => ['validation.type']]);
    expect(zErrors($s, '{"n":0}'))->toBe(['n' => ['validation.min']]);
    expect(zErrors($s, '{"n":"5"}'))->toBe(['n' => ['validation.type']]);
    expect($s->parse(Json::decode('{"n":1.0}')))->toBe(['n' => 1]);
});

it('massKg pads to three decimals and refuses zero', function () {
    $s = Z::object(['m' => Z::massKg()]);
    expect($s->parse(Json::decode('{"m":"12.5"}')))->toBe(['m' => '12.500']);
    expect(zErrors($s, '{"m":"0.000"}'))->toBe(['m' => ['validation.positive']]);
    expect(zErrors($s, '{"m":"1.2345"}'))->toBe(['m' => ['validation.mass.format']]);
});
