<?php

namespace App\Infrastructure\Redis;

/**
 * Lua scripts of the shared Redis protocols, byte for byte the ones of Express (LuaParityTest reads
 * backend-express/src/http/idempotency.ts): the idempotency record's compare-and-set to `done` and compare-and-delete
 * touch only the caller's own pending record — fingerprint and state compared after `cjson.decode` — never a finished
 * or a foreign one (R48). KEYS[1] — the record; ARGV[1] — the fingerprint; ARGV[2] (complete) — the done record.
 */
final class Scripts
{
    public const IDEM_DONE_TTL_SEC = 86400;

    private const OWN_PENDING = "
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok, d = pcall(cjson.decode, v)
if not ok or type(d) ~= 'table' or d.fingerprint ~= ARGV[1] or d.state ~= 'pending' then return 0 end
";

    public const IDEM_COMPLETE = self::OWN_PENDING."redis.call('SET', KEYS[1], ARGV[2], 'EX', 86400)
return 1";

    public const IDEM_RELEASE = self::OWN_PENDING."redis.call('DEL', KEYS[1])
return 1";
}
