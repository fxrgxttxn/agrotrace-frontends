<?php

/*
 * What @agrotrace/domain pins outside the vectors: the kg↔g bounds (R26: ≤ 9 integer digits, ≤ 3 decimals), the
 * code-point order (R21/R92 — UTF-8 byte order, astral after high-BMP), the state machine's available actions and the
 * decimal parser's refusals.
 */

use App\Domain\Decimal;
use App\Domain\StateMachine;
use App\Domain\Strings;

it('kgToGrams accepts the numeric(12,3) shapes', function (string $kg, string $g) {
    expect(Decimal::kgToGrams($kg))->toBe($g);
})->with([
    ['12', '12000'],
    ['1.5', '1500'],
    ['999999999.999', '999999999999'],
    ['0.001', '1'],
]);

it('kgToGrams refuses out-of-bounds and malformed masses (R26)', function (string $kg) {
    expect(fn () => Decimal::kgToGrams($kg))->toThrow(InvalidArgumentException::class);
})->with(['1000000000.000', '', ' 1.000', '-1.000', '1.0000', "1.000\n", '١.٠٠٠']);

it('gramsToKg prints exactly 3 decimals, also for negatives and 10^18 g', function () {
    expect(Decimal::gramsToKg('1'))->toBe('0.001');
    expect(Decimal::gramsToKg('-1500'))->toBe('-1.500');
    expect(Decimal::gramsToKg('1000000000000000000'))->toBe('1000000000000000.000');
});

it('ratioPercent2 rounds half up and stays exact beyond int64', function () {
    expect(Decimal::ratioPercent2('1', '20000'))->toBe('0.01'); // 0.005 % → half up
    expect(Decimal::ratioPercent2('1', '20001'))->toBe('0.00');
    expect(Decimal::ratioPercent2('99999999999999999999', '99999999999999999999'))->toBe('100.00');
});

it('compare is exact and scale-normalized; malformed decimals are refused', function () {
    expect(Decimal::compare('9.5', '10.0'))->toBe(-1);
    expect(Decimal::compare('2.0', '2.00'))->toBe(0);
    expect(Decimal::compare('10', '9.99'))->toBe(1);
    expect(fn () => Decimal::compare('1e3', '1'))->toThrow(InvalidArgumentException::class);
    expect(fn () => Decimal::percentToBasisPoints('5.555'))->toThrow(InvalidArgumentException::class);
});

it('compareCodePoints follows UTF-8 byte order (R92)', function (string $a, string $b) {
    $utf8 = strcmp($a, $b) <=> 0;
    expect(Strings::compareCodePoints($a, $b))->toBe($utf8);
    expect(Strings::compareCodePoints($b, $a))->toBe(-$utf8);
})->with([
    ['A', 'B'], ['B', 'a'], ['a', 'ab'], ['', 'a'], ["\u{FF21}", "\u{1D400}"], ["\u{1D400}", "\u{1D401}"],
    ["x\u{1F600}", "x\u{FFFF}"], ['Ёж', 'Жук'], ['same', 'same'],
]);

it('puts an astral character after a high-BMP one (where JavaScript `<` errs)', function () {
    expect(Strings::compareCodePoints("\u{1D400}", "\u{FF21}"))->toBe(1);
});

it('lists the available actions of a status in contract order', function () {
    expect(StateMachine::availableActions('Accepted'))->toBe([
        ['action' => 'ship', 'to' => 'InTransit'],
        ['action' => 'process', 'to' => 'Processed'],
        ['action' => 'putOnSale', 'to' => 'OnSale'],
        ['action' => 'recall', 'to' => 'Recalled'],
    ]);
    expect(StateMachine::availableActions('WrittenOff'))->toBe([]);
    expect(StateMachine::statuses())->toHaveCount(11);
});
