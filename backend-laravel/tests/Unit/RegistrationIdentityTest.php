<?php

/*
 * registerOrganization × DaData (R66; Express modules/auth/registration.ts, infra/dadata.ts): found → PENDING with
 * DaData's name and address; not found → `inn notFound`; unavailable → MANUAL_CHECK with the request's name, else
 * `name required`. No key → unavailable without a call; 4xx → unavailable at once; 5xx/network → 3 attempts.
 */

use App\Actions\Auth\AuthActions;
use App\Http\Problem\Problem;
use App\Infrastructure\Dadata\Dadata;
use App\Infrastructure\Dadata\DadataResult;
use Tests\TestCase;

uses(TestCase::class);

it('found → PENDING with the name and address of DaData', function () {
    expect(AuthActions::registrationIdentity(DadataResult::found('ООО «Ромашка»', 'г. Владимир'), 'Из запроса'))
        ->toBe(['name' => 'ООО «Ромашка»', 'address' => 'г. Владимир', 'status' => 'PENDING']);
});

it('notFound → 400 inn notFound', function () {
    expect(fn () => AuthActions::registrationIdentity(DadataResult::notFound(), 'X'))
        ->toThrow(fn (Problem $p) => expect($p->errors)->toBe(['inn' => ['validation.inn.notFound']]));
});

it('unavailable → MANUAL_CHECK with the request name; without one → name required', function () {
    expect(AuthActions::registrationIdentity(DadataResult::unavailable(), 'КФХ Тест'))
        ->toBe(['name' => 'КФХ Тест', 'address' => null, 'status' => 'MANUAL_CHECK']);
    expect(fn () => AuthActions::registrationIdentity(DadataResult::unavailable(), null))
        ->toThrow(fn (Problem $p) => expect($p->errors)->toBe(['name' => ['validation.required']]));
});

it('reads a suggestion: short name with OPF, then value, then the full name; none → notFound', function () {
    expect(Dadata::fromBody(['suggestions' => [['value' => 'V', 'data' => ['name' => ['short_with_opf' => 'S'], 'address' => ['value' => 'A']]]]]))
        ->toEqual(DadataResult::found('S', 'A'));
    expect(Dadata::fromBody(['suggestions' => [['value' => 'V', 'data' => []]]]))->toEqual(DadataResult::found('V', null));
    expect(Dadata::fromBody(['suggestions' => []]))->toEqual(DadataResult::notFound());
    expect(Dadata::fromBody(['suggestions' => [['data' => ['name' => []]]]]))->toEqual(DadataResult::notFound());
});

it('no key → unavailable without a call; 4xx → no retry; 5xx → 3 attempts, then unavailable', function () {
    $calls = 0;
    $post = function (string $inn) use (&$calls): array {
        $calls++;

        return ['status' => 500, 'body' => null];
    };
    config(['agrotrace.dadata.key' => null]);
    expect(Dadata::findParty('3328100013', $post, 0)->status)->toBe('unavailable');
    expect($calls)->toBe(0);

    config(['agrotrace.dadata.key' => 'k']);
    expect(Dadata::findParty('3328100013', $post, 0)->status)->toBe('unavailable');
    expect($calls)->toBe(3);

    $calls = 0;
    $rejected = function () use (&$calls): array {
        $calls++;

        return ['status' => 403, 'body' => null];
    };
    expect(Dadata::findParty('3328100013', $rejected, 0)->status)->toBe('unavailable');
    expect($calls)->toBe(1);

    $found = fn (): array => ['status' => 200, 'body' => ['suggestions' => [['value' => 'ООО «Найдено»']]]];
    expect(Dadata::findParty('3328100013', $found, 0))->toEqual(DadataResult::found('ООО «Найдено»', null));
});
