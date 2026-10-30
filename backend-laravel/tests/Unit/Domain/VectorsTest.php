<?php

/*
 * The shared vectors (contracts/rules/vectors/*.json, §14.1, M2): every case of every file through
 * App\Domain\Vectors::call — the same inputs and expected outputs as @agrotrace/domain's own vector test. Compared
 * twice: toEqual (the brief) and strictly on key-sorted JSON, so "1" never passes for 1 nor 1.0 for 1.
 */

use App\Contract\RulesRepo;
use App\Domain\Vectors;

function vectorFiles(): array
{
    $files = glob(RulesRepo::dir().'/vectors/*.json');
    sort($files);

    return $files;
}

function canonical(mixed $v): mixed
{
    if (is_array($v)) {
        if (! array_is_list($v)) {
            ksort($v);
        }

        return array_map('canonical', $v);
    }

    return $v;
}

dataset('vectors', function () {
    foreach (vectorFiles() as $file) {
        $v = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
        foreach ($v['cases'] as $case) {
            yield basename($file).' '.$case['name'] => [$v['fn'], $case['input'], $case['expected']];
        }
    }
});

it('matches the vector', function (string $fn, array $input, array $expected) {
    $out = Vectors::call($fn, $input);
    expect($out)->toEqual($expected);
    expect(json_encode(canonical($out)))->toBe(json_encode(canonical($expected)));
})->with('vectors');

it('covers every vector file of contracts/rules/vectors (none skipped)', function () {
    $files = vectorFiles();
    expect(count($files))->toBeGreaterThanOrEqual(15);
    $fns = [];
    foreach ($files as $file) {
        $v = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
        expect($v['cases'])->not->toBeEmpty();
        $fns[] = $v['fn'];
    }
    foreach (array_unique($fns) as $fn) {
        expect(Vectors::supports($fn))->toBeTrue("no domain function for vector fn {$fn}");
    }
});
