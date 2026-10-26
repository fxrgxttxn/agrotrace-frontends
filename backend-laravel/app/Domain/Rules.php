<?php

namespace App\Domain;

use App\Contract\RulesRepo;

/**
 * The business rules BR-01…BR-10 and the batch code (@agrotrace/domain rules.ts) — plain PHP, inputs and outputs in
 * exactly the shape of contracts/rules/vectors/*.json.
 */
final class Rules
{
    /**
     * BR-01: a batch cannot ship until every treatment's waiting period has elapsed: until = UTC date(appliedAt) +
     * waitingPeriodDays, allowed iff shipDate ≥ until. Of several blocking treatments the latest `until` is reported;
     * on a tie the substance with the smallest name in code-point order (R21).
     *
     * @param  array{shipDate: string, treatments: list<array{substance: string, appliedAt: string, waitingPeriodDays: int}>}  $i
     * @return array{ok: true}|array{ok: false, until: string, substance: string}
     */
    public static function checkWaitingPeriod(array $i): array
    {
        $worst = null;
        foreach ($i['treatments'] as $t) {
            $until = Dates::addDaysToDate(Dates::utcDate($t['appliedAt']), (int) $t['waitingPeriodDays']);
            if (strcmp($i['shipDate'], $until) >= 0) {
                continue;
            }
            if ($worst === null
                || strcmp($until, $worst['until']) > 0
                || ($until === $worst['until'] && Strings::compareCodePoints($t['substance'], $worst['substance']) < 0)) {
                $worst = ['until' => $until, 'substance' => $t['substance']];
            }
        }

        return $worst === null ? ['ok' => true] : ['ok' => false, ...$worst];
    }

    /**
     * BR-02: any indicator whose value strictly exceeds its norm fails the batch; exact decimal comparison.
     *
     * @param  array{results: list<array{indicatorId: string, value: string, maxValue: string|null}>}  $i
     * @return array{error: 'NO_RESULTS'}|array{conclusion: 'PASS'|'FAIL', exceeded: list<string>}
     */
    public static function concludeLabTest(array $i): array
    {
        if ($i['results'] === []) {
            return ['error' => 'NO_RESULTS'];
        }
        $exceeded = [];
        foreach ($i['results'] as $r) {
            if ($r['maxValue'] !== null && Decimal::compare($r['value'], $r['maxValue']) > 0) {
                $exceeded[] = $r['indicatorId'];
            }
        }

        return ['conclusion' => $exceeded === [] ? 'PASS' : 'FAIL', 'exceeded' => $exceeded];
    }

    /**
     * BR-03 risk model, in order: NEW_FARM (< 5 batches), LOW_RATING (< 70), RECENT_PESTICIDE (> 0), SAMPLED
     * (sha256(utf8 publicCode): first 4 bytes big-endian mod 100 < 20), else NONE.
     *
     * @param  array{publicCode: string, farmBatchCount: int, trustRating: int, pesticideTreatmentsLast30Days: int}  $i
     * @return array{required: bool, reason: 'NEW_FARM'|'LOW_RATING'|'RECENT_PESTICIDE'|'SAMPLED'|'NONE'}
     */
    public static function requiresLabTest(array $i): array
    {
        if ($i['farmBatchCount'] < 5) {
            return ['required' => true, 'reason' => 'NEW_FARM'];
        }
        if ($i['trustRating'] < 70) {
            return ['required' => true, 'reason' => 'LOW_RATING'];
        }
        if ($i['pesticideTreatmentsLast30Days'] > 0) {
            return ['required' => true, 'reason' => 'RECENT_PESTICIDE'];
        }
        if (self::sampleBucket($i['publicCode']) < 20) {
            return ['required' => true, 'reason' => 'SAMPLED'];
        }

        return ['required' => false, 'reason' => 'NONE'];
    }

    /**
     * BR-04: output ≤ input minus the normative loss, exactly in grams: allowed = Σ floor(g·(10000 − bp)/10000).
     * Inputs are checked before outputs (both empty → NO_INPUTS, R23).
     *
     * @param  array{inputs: list<array{massUsedKg: string, lossNormPercent: string}>, outputs: list<array{massKg: string}>}  $i
     * @return array{error: 'NO_INPUTS'|'NO_OUTPUTS'}|array{ok: bool, inputKg: string, allowedKg: string, outputKg: string}
     */
    public static function checkMassBalance(array $i): array
    {
        if ($i['inputs'] === []) {
            return ['error' => 'NO_INPUTS'];
        }
        if ($i['outputs'] === []) {
            return ['error' => 'NO_OUTPUTS'];
        }
        $input = '0';
        $allowed = '0';
        $output = '0';
        foreach ($i['inputs'] as $x) {
            $g = Decimal::kgToGrams($x['massUsedKg']);
            $input = bcadd($input, $g);
            $keep = bcsub('10000', Decimal::percentToBasisPoints($x['lossNormPercent']));
            $allowed = bcadd($allowed, bcdiv(bcmul($g, $keep), '10000', 0));
        }
        foreach ($i['outputs'] as $o) {
            $output = bcadd($output, Decimal::kgToGrams($o['massKg']));
        }

        return [
            'ok' => bccomp($output, $allowed) <= 0,
            'inputKg' => Decimal::gramsToKg($input),
            'allowedKg' => Decimal::gramsToKg($allowed),
            'outputKg' => Decimal::gramsToKg($output),
        ];
    }

    /**
     * BR-05: only Approved or Accepted batches may be processing inputs (sale: the state machine, R20).
     *
     * @param  array{status: string}  $i
     * @return array{allowed: bool}
     */
    public static function canUseAsInput(array $i): array
    {
        return ['allowed' => $i['status'] === 'Approved' || $i['status'] === 'Accepted'];
    }

    /**
     * BR-07: percent = round_half_up(|actual − declared| / declared · 100, 2); actRequired = |Δ|·100 > 2·declared in
     * grams (independent of the rounded percent); declared 0 → DECLARED_ZERO (R22).
     *
     * @param  array{declaredKg: string, actualKg: string}  $i
     * @return array{error: 'DECLARED_ZERO'}|array{percent: string, actRequired: bool}
     */
    public static function checkDiscrepancy(array $i): array
    {
        $d = Decimal::kgToGrams($i['declaredKg']);
        if (bccomp($d, '0') === 0) {
            return ['error' => 'DECLARED_ZERO'];
        }
        $a = Decimal::kgToGrams($i['actualKg']);
        $diff = bccomp($a, $d) > 0 ? bcsub($a, $d) : bcsub($d, $a);

        return [
            'percent' => Decimal::ratioPercent2($diff, $d),
            'actRequired' => bccomp(bcmul($diff, '100'), bcmul('2', $d)) > 0,
        ];
    }

    /**
     * BR-09: the farm's trust rating after an event (contracts/rules/trust-rating.json), clamped to [min, max].
     *
     * @param  array{current: int|float, event: string}  $i
     * @return array{rating: int}
     */
    public static function nextTrustRating(array $i): array
    {
        $tr = RulesRepo::json('trust-rating');
        // JavaScript's Math.round exactly: half towards +∞, and no `x + 0.5` (0.49999999999999994 + 0.5 rounds to 1.0 in
        // binary floating point, Math.round gives 0). Integers — the stored rating and the deltas — stay integers.
        $x = $i['current'] + $tr['deltas'][$i['event']];
        if (is_int($x)) {
            $rating = $x;
        } else {
            $down = floor($x);
            $rating = (int) ($x - $down >= 0.5 ? $down + 1 : $down);
        }

        return ['rating' => max($tr['min'], min($tr['max'], $rating))];
    }

    /**
     * BR-10: a recall closes once every task is CONFIRMED (an empty list closes vacuously).
     *
     * @param  array{taskStatuses: list<string>}  $i
     * @return array{close: bool}
     */
    public static function shouldCloseRecall(array $i): array
    {
        foreach ($i['taskStatuses'] as $s) {
            if ($s !== 'CONFIRMED') {
                return ['close' => false];
            }
        }

        return ['close' => true];
    }

    /**
     * The public batch code AT-{year}-{seq}, seq zero-padded to at least 6 digits, never truncated.
     *
     * @param  array{year: int, seq: int}  $i
     * @return array{code: string}
     */
    public static function formatBatchCode(array $i): array
    {
        return ['code' => sprintf('AT-%d-%s', $i['year'], str_pad((string) $i['seq'], 6, '0', STR_PAD_LEFT))];
    }

    private static function sampleBucket(string $publicCode): int
    {
        $n = unpack('N', substr(hash('sha256', $publicCode, true), 0, 4));

        return (int) $n[1] % 100;
    }
}
