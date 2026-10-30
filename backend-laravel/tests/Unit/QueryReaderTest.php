<?php

/*
 * Query parameters from the raw QUERY_STRING (L8; Express `qs` + http/params.ts): repeats are lists (and a scalar
 * parameter given twice is `validation.type`), `+` is a space, names keep their dots, brackets are lists or objects;
 * every error of the request in one 400.
 */

use App\Http\Problem\Problem;
use App\Http\Query\QueryReader;

it('decodes like qs: + is a space, %XX decoded, a malformed escape kept as sent; names keep their dots', function () {
    $q = new QueryReader('q=%D0%BC%D0%BE%D0%BB+%C2%AB&a.b=1&bad=%zz+x&empty=&flag');
    expect($q->string('q'))->toBe('мол «');
    expect($q->string('a.b'))->toBe('1');
    expect($q->has('a_b'))->toBeFalse();
    expect($q->string('bad'))->toBe('%zz x');
    expect($q->string('empty'))->toBe('');
    expect($q->string('flag'))->toBe('');
    expect($q->errors)->toBe([]);
});

it('a repeated scalar is validation.type; a repeated enum list is fine; duplicates and unknown values are not', function () {
    $q = new QueryReader('page=1&page=2&type=LAB&type=RETAILER&sort[x]=1');
    expect($q->string('page'))->toBeNull();
    expect($q->enums('type', ['LAB', 'RETAILER']))->toBe(['LAB', 'RETAILER']);
    expect($q->string('sort'))->toBeNull();
    expect($q->errors)->toBe(['page' => ['validation.type'], 'sort' => ['validation.type']]);
    expect((new QueryReader('type[]=LAB&type[]=FARM'))->enums('type', ['LAB', 'FARM']))->toBe(['LAB', 'FARM']);
    $d = new QueryReader('type=LAB&type=LAB&x=ZOO');
    expect($d->enums('type', ['LAB']))->toBeNull();
    expect($d->enums('x', ['LAB']))->toBeNull();
    expect($d->errors)->toBe(['type' => ['validation.duplicate'], 'x' => ['validation.enum']]);
});

it('page, size and sort against x-sort; everything wrong in one 400', function () {
    expect((new QueryReader(''))->page(['name'], 'name,asc'))->toBe(['page' => 1, 'size' => 20, 'sort' => ['field' => 'name', 'dir' => 'asc']]);
    expect((new QueryReader('page=2&size=3&sort=name,desc'))->page(['name'], 'name,asc'))
        ->toBe(['page' => 2, 'size' => 3, 'sort' => ['field' => 'name', 'dir' => 'desc']]);
    $q = new QueryReader('page=0&size=101&sort=inn,asc&q=&organizationId=nope&role=BOSS');
    $q->page(['name'], 'name,asc');
    $q->q();
    $q->uuid('organizationId');
    $q->enum('role', ['FARMER']);
    expect(fn () => $q->done())->toThrow(fn (Problem $p) => expect($p->errors)->toBe([
        'page' => ['validation.min'], 'size' => ['validation.max'], 'sort' => ['validation.sort'],
        'q' => ['validation.minLength'], 'organizationId' => ['validation.uuid'], 'role' => ['validation.enum'],
    ]));
    $x = new QueryReader('page=x&sort=email');
    $x->page(['email'], 'email,asc');
    expect($x->errors)->toBe(['page' => ['validation.type'], 'sort' => ['validation.sort']]);
});

it('q is 1…100 code points; dates are real calendar dates; notAllowed even with false', function () {
    $q = new QueryReader('q='.str_repeat('я', 100).'&from=2026-02-30&to=2026-01-01&includeDeleted=false');
    expect($q->q())->toBe(str_repeat('я', 100));
    expect($q->dateRange())->toBe(['from' => null, 'to' => '2026-01-01']);
    $q->notAllowed('includeDeleted');
    expect($q->errors)->toBe(['from' => ['validation.date.format'], 'includeDeleted' => ['validation.includeDeleted.notAllowed']]);
    expect((new QueryReader('q='.str_repeat('x', 101)))->q())->toBeNull();
    $r = new QueryReader('from=2026-03-02&to=2026-03-01');
    $r->dateRange();
    expect($r->errors)->toBe(['from' => ['validation.range']]);
});

// Fix round 1 (review M3), each case checked against api-express (qs with arrayLimit 1000, parameterLimit 1000).
it('reads indexes and the parameter count as Express\'s qs does', function () {
    expect((new QueryReader('type[999]=FARM'))->enums('type', ['FARM']))->toBe(['FARM']);
    foreach (['type[1000]=FARM', 'type[01]=FARM'] as $object) {
        $q = new QueryReader($object);
        expect($q->enums('type', ['FARM']))->toBeNull();
        expect($q->errors)->toBe(['type' => ['validation.type']]);
    }
    expect((new QueryReader(str_repeat('x=1&', 999).'type=ZOO'))->has('type'))->toBeTrue();
    expect((new QueryReader(str_repeat('x=1&', 1000).'type=ZOO'))->has('type'))->toBeFalse();
});
