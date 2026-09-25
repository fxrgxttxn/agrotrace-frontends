-- D1 (spec §13.5): delete a batch with edges and lab tests (cascade). Atomic: hash, code index,
-- held/held:status/stats, every edge to a neighbour (and that neighbour's own children/parents
-- set entry + the link:{parent}:{child} hash), every lab test on this batch (hash + tests:by_due
-- entry), and the batch:{id}:tests list itself all disappear in one script run, or (if the batch
-- does not exist) nothing changes at all.
--
-- KEYS: none.
-- ARGV[1] = batch id
-- returns: 1 if the batch was deleted, 0 if it did not exist.

local id = ARGV[1]
local batch_key = 'batch:' .. id

if redis.call('EXISTS', batch_key) == 0 then
  return 0
end

local status = redis.call('HGET', batch_key, 'status')
local holder = redis.call('HGET', batch_key, 'holder_org_id')
local public_code = redis.call('HGET', batch_key, 'public_code')

redis.call('ZREM', 'org:' .. holder .. ':held', id)
redis.call('ZREM', 'org:' .. holder .. ':held:' .. status, id)
redis.call('HINCRBY', 'stats:org:' .. holder, status, -1)
redis.call('DEL', 'batch:code:' .. public_code)

local children = redis.call('SMEMBERS', 'batch:' .. id .. ':children')
for _, child in ipairs(children) do
  redis.call('SREM', 'batch:' .. child .. ':parents', id)
  redis.call('DEL', 'link:' .. id .. ':' .. child)
end

local parents = redis.call('SMEMBERS', 'batch:' .. id .. ':parents')
for _, parent in ipairs(parents) do
  redis.call('SREM', 'batch:' .. parent .. ':children', id)
  redis.call('DEL', 'link:' .. parent .. ':' .. id)
end

redis.call('DEL', 'batch:' .. id .. ':children')
redis.call('DEL', 'batch:' .. id .. ':parents')

local test_ids = redis.call('LRANGE', 'batch:' .. id .. ':tests', 0, -1)
for _, tid in ipairs(test_ids) do
  redis.call('DEL', 'test:' .. tid)
  redis.call('ZREM', 'tests:by_due', tid)
end
redis.call('DEL', 'batch:' .. id .. ':tests')

redis.call('DEL', batch_key)

return 1
