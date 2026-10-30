<?php

/*
 * The analytics window (App\Actions\Analytics\Window; paths/analytics.yaml, reports.yaml): 30 days up to the
 * snapshot's UTC date by default, one end → the other 29 days from it, > 366 days → `validation.range.tooLong`; the
 * four-digit calendar edges (year 0000, 9999-12-31) as the other date filters treat them. And the dashboard's
 * parameter rules (scope and window errors in one 400, before any SQL), `Hours` and the rejected-share order (P47).
 */

use App\Actions\Analytics\Dashboard;
use App\Actions\Analytics\Window;
use App\Http\Problem\Problem;
use App\Http\Query\QueryReader;
use App\Security\Principal;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

uses(TestCase::class);

it('defaults to 30 days up to the snapshot date', function () {
    expect(Window::resolve(null, null, '2026-03-01'))->toBe(['from' => '2026-01-31', 'to' => '2026-03-01']);
    expect(Window::resolve(null, null, '2024-03-01'))->toBe(['from' => '2024-02-01', 'to' => '2024-03-01']);
    // The snapshot's now() text in the UTC session gives the date.
    expect(Window::dateOf('2026-03-01 23:59:59.999999+00'))->toBe('2026-03-01');
});

it('one end gives the other 29 days from it; both ends are kept', function () {
    expect(Window::resolve('2026-03-01', null, '2026-10-26'))->toBe(['from' => '2026-03-01', 'to' => '2026-03-30']);
    expect(Window::resolve(null, '2026-03-01', '2026-10-26'))->toBe(['from' => '2026-01-31', 'to' => '2026-03-01']);
    expect(Window::resolve('2026-03-01', '2026-03-05', '2026-10-26'))->toBe(['from' => '2026-03-01', 'to' => '2026-03-05']);
});

it('366 days is the limit, only for explicit bounds', function () {
    expect(Window::tooLong('2025-03-01', '2026-03-01'))->toBeFalse(); // 366 days
    expect(Window::tooLong('2025-02-28', '2026-03-01'))->toBeTrue();
    expect(Window::tooLong('2024-01-01', '2024-12-31'))->toBeFalse(); // a leap year: 366 days
    expect(Window::tooLong('2023-12-31', '2024-12-31'))->toBeTrue();
    expect(Window::tooLong(null, '2026-03-01'))->toBeFalse();
    expect(Window::tooLong('2020-01-01', null))->toBeFalse();
});

it('the calendar edges: year 0000 is a leap year, a computed end beyond 9999 / before 0000 is clamped, 9999-12-31 ends at infinity', function () {
    expect(Window::shift('0000-03-01', -1))->toBe('0000-02-29');
    expect(Window::shift('0001-01-01', -1))->toBe('0000-12-31');
    expect(Window::shift('1970-01-01', 0))->toBe('1970-01-01');
    expect(Window::shift('2026-12-31', 1))->toBe('2027-01-01');
    expect(Window::resolve(null, '0001-01-10', '2026-10-26'))->toBe(['from' => '0000-12-12', 'to' => '0001-01-10']);
    expect(Window::resolve('9999-12-31', null, '2026-10-26'))->toBe(['from' => '9999-12-31', 'to' => '9999-12-31']);
    expect(Window::resolve(null, '0000-01-01', '2026-10-26'))->toBe(['from' => '0000-01-01', 'to' => '0000-01-01']);
    expect(Window::tooLong('0000-01-01', '0000-12-31'))->toBeFalse();
    expect(Window::tooLong('0000-01-01', '0001-01-01'))->toBeTrue();
    expect(Window::bounds(['from' => '9999-12-20', 'to' => '9999-12-31']))->toBe(['9999-12-20 00:00:00+00', 'infinity']);
    expect(Window::bounds(['from' => '2026-03-01', 'to' => '2026-03-01']))->toBe(['2026-03-01 00:00:00+00', '2026-03-02 00:00:00+00']);
    expect(Window::bounds(['from' => '0000-01-01', 'to' => '0000-12-31']))->toBe(['0001-01-01 00:00:00+00 BC', '0001-01-01 00:00:00+00']);
    // Day numbers round-trip over the whole calendar.
    foreach (['0000-01-01', '0000-02-29', '0399-12-31', '0400-03-01', '1900-02-28', '2000-02-29', '9999-12-31'] as $d) {
        expect(Window::date(Window::days($d)))->toBe($d);
    }
    expect(Window::days('1970-01-01'))->toBe(0);
});

/** @return array<string, list<string>> */
function dashboardErrors(string $query, Principal $p): array
{
    $queries = 0;
    DB::listen(function () use (&$queries): void {
        $queries++;
    });
    try {
        Dashboard::get($p, new QueryReader($query));
    } catch (Problem $e) {
        expect($e->status)->toBe(400);
        expect($queries)->toBe(0); // the parameters are checked before the snapshot

        return $e->errors ?? [];
    }
    throw new RuntimeException('no 400');
}

it('scope and window errors come in one 400, before any SQL', function () {
    $lab = new Principal('u', 'o', ['LAB'], false);
    expect(dashboardErrors('scope=inspector&from=2026-02-30', $lab))
        ->toBe(['scope' => ['validation.scope.notAllowed'], 'from' => ['validation.date.format']]);
    expect(dashboardErrors('scope=lab&from=2025-02-28&to=2026-03-01', $lab))->toBe(['from' => ['validation.range.tooLong']]);
    expect(dashboardErrors('scope=lab&from=2026-03-02&to=2026-03-01', $lab))->toBe(['from' => ['validation.range']]);
    expect(dashboardErrors('', $lab))->toBe(['scope' => ['validation.required']]);
    expect(dashboardErrors('scope=all&to=x', $lab))->toBe(['scope' => ['validation.enum'], 'to' => ['validation.date.format']]);
    // Roles are a union: an ADMIN head is not an organization participant.
    expect(dashboardErrors('scope=org', new Principal('u', 'o', ['ADMIN'], true)))->toBe(['scope' => ['validation.scope.notAllowed']]);
});

it('Hours: whole seconds over N × 3600, half up; none — null', function () {
    expect(Dashboard::hours('5400', 1))->toBe('1.50');
    expect(Dashboard::hours('5400', 2))->toBe('0.75');
    expect(Dashboard::hours('18', 1))->toBe('0.01'); // 0.005 h → 0.01 (half up)
    expect(Dashboard::hours('17', 1))->toBe('0.00');
    expect(Dashboard::hours('0', 0))->toBeNull();
    // Beyond double precision: 10^15 h over 3 records.
    expect(Dashboard::hours('3600000000000000000', 3))->toBe('333333333333333.33');
});

it('rejectedShare: by the ROUNDED share (P47), then tested desc, then the name by code points; top 10', function () {
    $row = fn (string $key, string $name, int $tested, int $failed): object => (object) compact('key', 'name', 'tested', 'failed');
    // 1/3 = 33.333… and 3333/10000 = 33.33 round to the same share: tested decides, not the exact ratio.
    $top = Dashboard::topShares([$row('a', 'A', 3, 1), $row('b', 'B', 10000, 3333), $row('c', 'C', 2, 2)]);
    expect(array_column($top, 'key'))->toBe(['c', 'b', 'a']);
    expect($top[1])->toBe(['key' => 'b', 'name' => 'B', 'tested' => 10000, 'failed' => 3333, 'share' => '33.33']);
    // Equal share and tested: code-point order of the name (Я < а < ё).
    $byName = Dashboard::topShares([$row('1', 'ё', 4, 1), $row('2', 'а', 4, 1), $row('3', 'Я', 4, 1)]);
    expect(array_column($byName, 'name'))->toBe(['Я', 'а', 'ё']);
    $many = Dashboard::topShares(array_map(fn (int $i) => $row("k{$i}", "n{$i}", 100, $i), range(1, 12)));
    expect($many)->toHaveCount(10);
    expect($many[0]['share'])->toBe('12.00');
    expect($many[9]['share'])->toBe('3.00');
});
