<?php

namespace App\Domain;

use App\Contract\RulesRepo;

/** The batch status machine of contracts/rules/state-machine.json (@agrotrace/domain state-machine.ts). */
final class StateMachine
{
    /** @return list<string> */
    public static function statuses(): array
    {
        return RulesRepo::json('state-machine')['statuses'];
    }

    /**
     * @param  array{from: string, to: string}  $i
     * @return array{allowed: bool}
     */
    public static function canTransition(array $i): array
    {
        foreach (self::transitions() as $t) {
            if ($t['from'] === $i['from'] && $t['to'] === $i['to']) {
                return ['allowed' => true];
            }
        }

        return ['allowed' => false];
    }

    /** @return list<array{action: string, to: string}> */
    public static function availableActions(string $from): array
    {
        $out = [];
        foreach (self::transitions() as $t) {
            if ($t['from'] === $from) {
                $out[] = ['action' => $t['action'], 'to' => $t['to']];
            }
        }

        return $out;
    }

    /** @return list<array{from: string, to: string, action: string}> */
    private static function transitions(): array
    {
        return RulesRepo::json('state-machine')['transitions'];
    }
}
