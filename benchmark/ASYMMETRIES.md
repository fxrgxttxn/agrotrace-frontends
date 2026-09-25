# Query implementation asymmetries (PostgreSQL vs Redis)

Task 3's queries (`agrobench/queries/{pg.py,redis.py}`) give identical *logical* results (proven
by `tests/test_query_equivalence.py`), but the two implementations are not line-for-line mirrors
of each other — they can't be, since they run on two very different storage engines. This file
records the deliberate differences that fell out of that, for `docs/reports/databases.md` (Task 5)
to draw on when it compares the two DBMS. Fix round 1 (independent review) asked for this to be
written down explicitly rather than left implicit in code comments.

## R3: order on tied timestamps

PostgreSQL's `ORDER BY harvested_at DESC, id DESC` (`agrobench/queries/pg.py:r3_holder_batches_by_status`)
has a real, if defensive, tie-break: two rows with equal `harvested_at` still sort in one defined
order (newest id first). Redis's `ZREVRANGE org:{id}:held:{status}` has no equivalent — Redis
sorted sets break score ties by comparing member strings *lexicographically*, not numerically
("10" sorts before "9"), which would silently diverge from PostgreSQL's `id DESC` tie-break if it
ever mattered.

The chosen fix is not to replicate PostgreSQL's tie-break inside Redis (a composite score encoding
`harvested_at` and `id` together would work but adds complexity and a second code path to keep in
sync). Instead, `agrobench/generate.py` asserts `harvested_at` is unique *globally* across all
generated batches (a stronger guarantee than "per holder", achieved for free since generation uses
one strictly-increasing timestamp counter for every batch), and `redis_keys.org_held_status_key`
documents the invariant for anything that writes batches outside the generator (W1/W2 callers,
including test fixtures). PostgreSQL's `id DESC` stays as defense-in-depth: if the invariant is
ever violated, PostgreSQL's order stays *total* (deterministic, if now holder-specific) rather than
becoming ambiguous, even though it would then disagree with Redis's lexicographic tie-break.

## R5: how each side avoids doing extra work on a DAG

PostgreSQL's `WITH RECURSIVE ... UNION` deduplicates the recursive working table by the pair
`(id, depth)`, not by `id` alone (that's what `UNION`, as opposed to `UNION ALL`, buys here). A
descendant reachable from the start batch by two paths of *different* lengths can therefore still
be re-expanded once per distinct depth at which it's first reached, before the final
`SELECT DISTINCT id` collapses everything to one row per id. Redis's two variants (`r5_descendants`
BFS-by-level, `r5_descendants_lua`) instead track a `visited` set and never re-expand a node once
discovered, at any depth — each descendant does exactly one unit of traversal work, ever. Same
final *set*, different amount of work to reach it; this is a shape difference worth noting for
Task 5's performance comparison, not a correctness one (`test_r5_descendants_match_for_every_batch_both_redis_variants`
and the max_depth-parametrized regression tests cover the DAG cases where this could matter — a
diamond and depth > 1 — and confirm all three implementations still land on the same set).

## W1: who maintains the indexes

PostgreSQL's `w1_insert_batch` is one `INSERT`; the unique index on `public_code` and the covering
index on `(holder_org_id, status, harvested_at DESC)` come from the schema and are maintained by
the database engine itself, with no application code involved. Redis's `w1_insert_batch` has to do
that work by hand — five separate writes (the hash, the code index, both zsets, the stats counter)
wrapped in `MULTI`/`EXEC` so they land atomically — because Redis has no built-in secondary index
concept; every "index" in the spec §13.3 schema is really just more applicationmaintained data.
This is the central architectural asymmetry the benchmark exists to measure: PostgreSQL trades
per-write index-maintenance cost (paid by the engine, transparently) for Redis's explicit
per-write fan-out (paid by the client, five round-trip-equivalents batched into one pipeline call)
— `assert_redis_invariants` exists specifically because Redis's side of that trade can drift if any
future write path forgets one of the five.

## R4: test ordering has no natural common order

PostgreSQL's `r4_batch_with_holder_and_tests` explicitly orders its nested `json_agg` by
`t.id` (`ORDER BY t.id` inside the correlated subselect). Redis's `batch:{id}:tests` is a plain
`LIST`, and `r4_batch_with_holder_and_tests` returns its members in whatever order they were
`RPUSH`ed — which happens to be id order for data loaded by `load_redis.py` or inserted one test at
a time, but is not a property either implementation actually enforces going forward (nothing
re-sorts the Redis list on future writes; spec §13.5 defines no insert-test query at all, so this
codebase never mutates that list past load time). The equivalence tests
(`test_r4_batch_with_holder_and_tests_matches_for_every_batch`) sort both sides by `id` in Python
before comparing for exactly this reason — the two DBMS's natural orders are not guaranteed to
agree by construction, only by how this specific loader happens to write them.

## W2: pipeline atomicity granularity

PostgreSQL's `w2_insert_batches_multirow` (the `unnest`-based variant) is a single SQL statement —
atomic in its entirety by definition, all 10 000 rows or none. Redis's `w2_insert_batches` is a
non-transactional pipeline (`transaction=False`), flushed every 1000 *batches* (5000 individual
commands): each individual batch's own five writes stay together in send order, but the pipeline
as a whole is not wrapped in `MULTI`/`EXEC`, so a crash mid-pipeline could in principle leave some
prefix of the batches fully written and the rest not written at all (never a batch half-written —
each one's five commands are queued contiguously — but the *pipeline* itself has no all-or-nothing
guarantee the way one PostgreSQL statement does). This is intentional: spec §13.5 asks for "a
pipeline of W1s", not an atomic bulk-load transaction, and W2's actual ids are always freshly
allocated by the caller, never touched by any other concurrent writer, so partial application on a
crash is recoverable the same way it would be for any interrupted bulk load (retry the remainder).

## Measurement harness (Task 4): what is the same, what cannot be

Identical for both DBMS: the same Python process layout, the same asyncio call shape
(`await op(conn, *args)` timed with `perf_counter_ns`, `agrobench/measure.py`), the same key
sequences (a function of the generated CSVs, query, distribution and phase only —
`agrobench/workload.py:read_args`), the same warm-up (1000 calls, same distribution, same Zipf hot
set), the same prepared records (fresh `Allocator` per DBMS and run, so ids/timestamps match
exactly), the same restore-and-verify step after every write/delete series, and the same client
topology: concurrency 1 = one asyncio client in the parent process; concurrency 16 = 8 client
processes x 2 asyncio clients, 16 connections in total (`agrobench/run.py:CLIENT_PROCS`).

What differs, because the drivers differ:

- **Connection pool use.** A PostgreSQL client checks one connection out of its
  `AsyncConnectionPool` for the whole series (psycopg has no per-statement pool checkout);
  redis-py's asyncio client checks a connection out of its `BlockingConnectionPool` per command
  (that is how redis-py pools work). Both pools are filled before the series starts, so neither
  side pays for connection setup inside a measurement.
- **Prepared statements** exist only on the PostgreSQL side (psycopg prepares a statement
  server-side from its 5th execution on a connection; the 1000-call warm-up guarantees every
  pooled connection is past that). Redis has no equivalent; its closest analogue — Lua scripts
  called by SHA (`EVALSHA`) instead of full text — is used for R5-lua, W3 and D1. The
  `variant=unprepared` rows (PostgreSQL, concurrency 1, uniform) measure the same reads with
  prepared statements disabled, so the report can show what that optimisation is worth.
- **Round trips per logical call** differ where the data model forces it (R2, R3, R4, R5-bfs
  need 2+ dependent Redis round trips; each is one SQL statement) — this is part of what is being
  compared, not a harness artefact.
- **Restore mechanics.** PostgreSQL prepared rows are removed by id range and the three touched
  tables are `VACUUM ANALYZE`d (untimed) after each series, so dead tuples from one series never
  land in the next one's numbers; Redis prepared records are removed with the D1 script and the
  touched `stats:org:*` hashes are restored from a snapshot (HINCRBY -1 leaves a "0" field where
  none existed before). Both then prove full-content equality with the pre-series fingerprint.

Known biases that apply to both and are reported rather than hidden: every latency includes the
Docker bridge network hop and Python/asyncio client time (`client_cpu_cores` per series shows how
much CPU the client used — around 0.7 of a core per client process at concurrency 1); both DBMS
containers are capped at 2 CPUs, so at concurrency 16 CPU-heavy PostgreSQL queries (R4, R5) hit
the CFS quota and show multi-millisecond p99 throttling stalls; and nothing else on the host is
stopped for the run (other compose projects keep running), which is why every configuration is
measured three times and the median reported alongside the min/max p50 across runs.
