"""Query implementations for the PostgreSQL/Redis benchmark (spec §13.5): `pg.py` and `redis.py`
export the same function names/signatures (R1-R6, W1-W3, D1-D2) so Task 4's measurement harness
can treat `conn` as an opaque handle and swap DBMS without changing call sites. `lua/` holds the
Redis-side Lua scripts (R5 variant 2, W3, D1) that `redis.py` loads and evaluates.
"""
