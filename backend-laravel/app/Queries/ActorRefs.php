<?php

namespace App\Queries;

use App\Security\FileUrls;
use Illuminate\Support\Facades\DB;

/**
 * The contract's `ActorRef` (schemas/recalls.yaml; Express recalls/view.ts `actorRefs`): a user's id, full name and
 * avatar as a signed URL (R28).
 */
final class ActorRefs
{
    /**
     * ActorRef of the users $ids (nulls and repeats ignored), by id; unknown ids are absent.
     *
     * @param  list<string|null>  $ids
     * @return array<string, array{id: string, fullName: string, avatarUrl: string|null}>
     */
    public static function of(array $ids): array
    {
        $want = array_values(array_unique(array_filter($ids, fn ($x) => $x !== null)));
        if ($want === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($want), '?'));
        $out = [];
        foreach (DB::select("SELECT id, full_name, avatar_file_id FROM users WHERE id IN ({$marks})", $want) as $u) {
            $out[$u->id] = [
                'id' => $u->id,
                'fullName' => $u->full_name,
                'avatarUrl' => $u->avatar_file_id !== null ? FileUrls::signed($u->avatar_file_id) : null,
            ];
        }

        return $out;
    }
}
