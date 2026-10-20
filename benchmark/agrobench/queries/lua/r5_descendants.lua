-- R5 variant 2 (spec §13.5): downward graph traversal, one round trip. BFS by levels, same
-- semantics as agrobench.queries.redis.r5_descendants (the pipelined-Python variant) and
-- PostgreSQL's `WITH RECURSIVE ... WHERE depth < max_depth`: returns the *set* of descendant ids
-- reachable from ARGV[1] within ARGV[2] levels, each id exactly once even when reached by several
-- paths (DAG, shared descendants).
--
-- KEYS: none (key names are built from ARGV, matching redis_keys.batch_children_key).
-- ARGV[1] = start batch id (string)
-- ARGV[2] = max depth (string, converted to a number)
-- returns: array of descendant ids (strings), no particular order.

local start_id = ARGV[1]
local max_depth = tonumber(ARGV[2])

local visited = {}
visited[start_id] = true
local frontier = { start_id }
local result = {}
local depth = 0

while #frontier > 0 and depth < max_depth do
  local next_frontier = {}
  for _, bid in ipairs(frontier) do
    local children = redis.call('SMEMBERS', 'batch:' .. bid .. ':children')
    for _, child in ipairs(children) do
      if not visited[child] then
        visited[child] = true
        table.insert(next_frontier, child)
        table.insert(result, child)
      end
    end
  end
  frontier = next_frontier
  depth = depth + 1
end

return result
