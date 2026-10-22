<?php

/*
 * The from/to UTC-day bounds (UtcDays, Express dayAfter) at the edges of `format: date`, and the calendar check of
 * QueryReader (a JavaScript Date round trip: years 0000–9999, 0000 a leap year).
 */

use App\Http\Query\QueryReader;
use App\Support\UtcDays;

it('start and the day after, as timestamptz literals; year 0 is 1 BC; nothing after 9999-12-31', function () {
    expect(UtcDays::start('2026-10-22'))->toBe('2026-10-22 00:00:00+00');
    expect(UtcDays::after('2026-10-22'))->toBe('2026-10-23 00:00:00+00');
    expect(UtcDays::after('2024-02-28'))->toBe('2024-02-29 00:00:00+00');
    expect(UtcDays::after('2025-02-28'))->toBe('2025-03-01 00:00:00+00');
    expect(UtcDays::after('2025-12-31'))->toBe('2026-01-01 00:00:00+00');
    expect(UtcDays::after('9999-12-30'))->toBe('9999-12-31 00:00:00+00');
    expect(UtcDays::after('9999-12-31'))->toBeNull();
    expect(UtcDays::start('0000-01-01'))->toBe('0001-01-01 00:00:00+00 BC');
    expect(UtcDays::after('0000-12-31'))->toBe('0001-01-01 00:00:00+00');
    expect(UtcDays::after('0000-02-28'))->toBe('0001-02-29 00:00:00+00 BC');
    expect(UtcDays::start('0999-12-31'))->toBe('0999-12-31 00:00:00+00');
});

it('range: inclusive bounds; to=9999-12-31 has no upper bound', function () {
    expect(UtcDays::range('t.c', '2026-01-01', '2026-01-31'))->toBe([['t.c >= ?::timestamptz', 't.c < ?::timestamptz'], ['2026-01-01 00:00:00+00', '2026-02-01 00:00:00+00']]);
    expect(UtcDays::range('t.c', null, '9999-12-31'))->toBe([[], []]);
    expect(UtcDays::range('t.c', null, null))->toBe([[], []]);
});

it('calendar dates as Express accepts them', function (string $s, bool $ok) {
    expect(QueryReader::isCalendarDate($s))->toBe($ok);
})->with([
    ['2026-02-28', true], ['2026-02-29', false], ['2024-02-29', true], ['0000-02-29', true], ['0000-01-01', true],
    ['9999-12-31', true], ['1900-02-29', false], ['2000-02-29', true], ['2026-13-01', false], ['2026-00-10', false],
    ['2026-04-31', false], ['10000-01-01', false], ['2026-1-01', false],
]);
