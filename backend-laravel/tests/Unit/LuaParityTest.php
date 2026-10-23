<?php

/*
 * The idempotency Lua scripts are byte for byte Express's (backend-express/src/http/idempotency.ts: the template
 * literals OWN_PENDING, COMPLETE_LUA, RELEASE_LUA with their `${…}` interpolations resolved), so every backend settles
 * the shared records with the same compare-and-set / compare-and-delete. Reads the repository (php-tools mounts it).
 */

use App\Http\Idempotency\IdemStore;
use App\Infrastructure\Redis\Scripts;

/** @return array<string, string> the resolved string constants of the TypeScript file */
function expressIdemConstants(): array
{
    $file = dirname(__DIR__, 3).'/backend-express/src/http/idempotency.ts';
    $src = file_get_contents($file);
    expect($src)->toBeString("{$file} is readable");
    $values = [];
    preg_match_all('/^(?:export )?const ([A-Z_]+) = (\d+);$/m', (string) $src, $nums, PREG_SET_ORDER);
    foreach ($nums as [, $name, $value]) {
        $values[$name] = $value;
    }
    preg_match_all('/^const ([A-Z_]+) = `([^`]*)`;$/ms', (string) $src, $tpls, PREG_SET_ORDER);
    foreach ($tpls as [, $name, $tpl]) {
        $values[$name] = preg_replace_callback('/\$\{([A-Z_]+)\}/', function (array $m) use (&$values): string {
            expect($values)->toHaveKey($m[1]);

            return $values[$m[1]];
        }, $tpl);
    }

    return $values;
}

it('IDEM_COMPLETE and IDEM_RELEASE are the texts of Express COMPLETE_LUA and RELEASE_LUA', function () {
    $ts = expressIdemConstants();
    expect($ts)->toHaveKeys(['OWN_PENDING', 'COMPLETE_LUA', 'RELEASE_LUA', 'PENDING_TTL_SEC', 'DONE_TTL_SEC']);
    expect(Scripts::IDEM_COMPLETE)->toBe($ts['COMPLETE_LUA']);
    expect(Scripts::IDEM_RELEASE)->toBe($ts['RELEASE_LUA']);
    expect((string) IdemStore::PENDING_TTL_SEC)->toBe($ts['PENDING_TTL_SEC']);
    expect((string) IdemStore::DONE_TTL_SEC)->toBe($ts['DONE_TTL_SEC']);
    expect(Scripts::IDEM_DONE_TTL_SEC)->toBe(IdemStore::DONE_TTL_SEC);
});
