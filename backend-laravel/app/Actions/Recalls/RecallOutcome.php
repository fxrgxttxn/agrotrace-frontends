<?php

namespace App\Actions\Recalls;

/**
 * The result of the recall engine (Express recalls/engine.ts `RecallOutcome`): the recall's id; `created` false — an
 * OPEN recall of the source was reused (steps 2–7 skipped); `closed` — closed at creation (BR-10, no task); the batches
 * moved to Recalled (their public pages are dropped after the commit, R82); the tasks; the outbox rows written
 * (`recall.requested` of a new recall).
 */
final class RecallOutcome
{
    /**
     * @param  list<string>  $changedCodes
     * @param  list<string>  $taskIds
     * @param  list<string>  $eventIds
     */
    public function __construct(
        public readonly string $recallId,
        public readonly bool $created,
        public readonly bool $closed,
        public readonly array $changedCodes,
        public readonly array $taskIds,
        public readonly array $eventIds,
    ) {}

    public static function reused(string $recallId): self
    {
        return new self($recallId, false, false, [], [], []);
    }
}
