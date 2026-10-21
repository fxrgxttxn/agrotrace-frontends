<?php

namespace App\Domain;

use InvalidArgumentException;

/**
 * The vector dispatcher (tests/Unit/Domain/VectorsTest): the `fn` names of contracts/rules/vectors/*.json — the
 * exported names of @agrotrace/domain — mapped to this port's domain functions.
 */
final class Vectors
{
    private const FUNCTIONS = [
        'checkWaitingPeriod' => [Rules::class, 'checkWaitingPeriod'],
        'concludeLabTest' => [Rules::class, 'concludeLabTest'],
        'requiresLabTest' => [Rules::class, 'requiresLabTest'],
        'checkMassBalance' => [Rules::class, 'checkMassBalance'],
        'canUseAsInput' => [Rules::class, 'canUseAsInput'],
        'checkDiscrepancy' => [Rules::class, 'checkDiscrepancy'],
        'nextTrustRating' => [Rules::class, 'nextTrustRating'],
        'shouldCloseRecall' => [Rules::class, 'shouldCloseRecall'],
        'formatBatchCode' => [Rules::class, 'formatBatchCode'],
        'canTransition' => [StateMachine::class, 'canTransition'],
        'addWorkingDays' => [Dates::class, 'addWorkingDays'],
        'recallTaskDueAt' => [Dates::class, 'recallTaskDueAt'],
        'isOverdue' => [Dates::class, 'isOverdue'],
        'canEditTreatment' => [Dates::class, 'canEditTreatment'],
        'idempotencyDecision' => [Idempotency::class, 'decision'],
    ];

    /**
     * @param  array<string, mixed>  $input
     * @return array<string, mixed>
     */
    public static function call(string $fn, array $input): array
    {
        if (! isset(self::FUNCTIONS[$fn])) {
            throw new InvalidArgumentException("no domain function for vector fn {$fn}");
        }

        return (self::FUNCTIONS[$fn])($input);
    }

    public static function supports(string $fn): bool
    {
        return isset(self::FUNCTIONS[$fn]);
    }
}
