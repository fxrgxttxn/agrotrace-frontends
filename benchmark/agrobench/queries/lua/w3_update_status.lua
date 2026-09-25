-- W3 (spec §13.5): status change with an optimistic-lock version check. Atomic: reads the current
-- version and, only if it matches ARGV[3], writes the new status/version and moves the batch
-- between the org:{holder}:held:{status} sorted sets and stats:org:{holder} counters in the same
-- script run — no other client can observe a half-migrated state, and a stale version leaves
-- every structure untouched (spec: "устаревшая версия -> отказ").
--
-- KEYS: none.
-- ARGV[1] = batch id
-- ARGV[2] = new status
-- ARGV[3] = expected current version
-- returns: 1 on success, 0 if the batch does not exist or the version does not match.

local id = ARGV[1]
local new_status = ARGV[2]
local expected_version = tonumber(ARGV[3])
local batch_key = 'batch:' .. id

local current_version = redis.call('HGET', batch_key, 'version')
if not current_version then
  return 0
end
if tonumber(current_version) ~= expected_version then
  return 0
end

local old_status = redis.call('HGET', batch_key, 'status')
local holder = redis.call('HGET', batch_key, 'holder_org_id')
local new_version = tostring(expected_version + 1)

redis.call('HSET', batch_key, 'status', new_status, 'version', new_version)

if old_status ~= new_status then
  redis.call('ZREM', 'org:' .. holder .. ':held:' .. old_status, id)
  local score = redis.call('ZSCORE', 'org:' .. holder .. ':held', id)
  if not score then
    score = 0
  end
  redis.call('ZADD', 'org:' .. holder .. ':held:' .. new_status, score, id)
  redis.call('HINCRBY', 'stats:org:' .. holder, old_status, -1)
  redis.call('HINCRBY', 'stats:org:' .. holder, new_status, 1)
end

return 1
