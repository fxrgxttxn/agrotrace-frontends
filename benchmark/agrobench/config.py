"""Shared paths/constants and profile-config parsing (spec §13.6).

Parses the checked-in benchmark/pg/*.conf and benchmark/redis/*.conf profile files into plain
dicts, and derives the settings a running container is expected to report for a given
(profile, durability) pair — durability (strict/relaxed) is layered on top of whatever the
profile file says, mirroring how benchmark/bench.sh actually starts the containers (command-line
`-c`/flags override the mounted config file). Used by agrobench.env (env.json) and by
tests/test_env.py, which checks the *live* SHOW/CONFIG GET values against this, not the other
way around — this module never talks to a database itself.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parent.parent
PG_DIR = BENCH_DIR / "pg"
REDIS_DIR = BENCH_DIR / "redis"
DURABILITY_FILE = BENCH_DIR / "durability.conf"

# Identical for bench-postgres and bench-redis (benchmark/docker-compose.yml `cpus`/`mem_limit`;
# pg/tuned.conf and redis/tuned.conf are sized off MEM_MB too — keep all three in sync). This is
# the *declared* value; agrobench.env additionally introspects the *actual* running limits via
# `docker inspect` (bench.sh has host-side docker access; env.py, inside bench-runner, doesn't)
# and tests/test_env.py fails if the two disagree.
RESOURCE_LIMITS = {"cpus": 2, "mem_mb": 4096}

_PG_SIZE_SETTINGS = {
    "shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem", "max_wal_size",
}
_PG_FLOAT_SETTINGS = {"random_page_cost"}
_PG_INT_SETTINGS = {"effective_io_concurrency", "max_connections"}

_SIZE_RE = re.compile(r"^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]*)$")
_PG_UNITS = {"": 1, "b": 1, "kb": 1024, "mb": 1024**2, "gb": 1024**3, "tb": 1024**4}
_REDIS_UNITS = {
    "": 1, "b": 1,
    "k": 1000, "kb": 1024,
    "m": 1000**2, "mb": 1024**2,
    "g": 1000**3, "gb": 1024**3,
}


def parse_pg_conf(path: Path) -> dict[str, str]:
    """Parses a postgresql.conf-style file (`key = value  # comment`) into {key: raw_value}."""
    settings: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1]
        settings[key] = value
    return settings


def parse_redis_conf(path: Path) -> dict[str, str]:
    """Parses a redis.conf-style file (`key value...`) into {key: raw_value}.

    Directives that can repeat (only `save` does, in these two files) keep just their last
    occurrence — callers that need `save` should read the file themselves; nothing here compares
    it (CONFIG GET save's accumulated multi-line format isn't worth reproducing for a value the
    tests don't assert on).
    """
    settings: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition(" ")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        settings[key.lower()] = value
    return settings


def parse_durability_conf(path: Path = DURABILITY_FILE) -> dict[str, str]:
    """Parses durability.conf (`<durability>.<key>=<value>`) into {"strict.pg_synchronous_commit":
    "on", ...} — the single source of truth for the durability -> concrete-setting mapping,
    shared with benchmark/bench.sh (parsed there with grep/cut, not this function)."""
    settings: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        settings[key.strip()] = value.strip()
    return settings


def pg_synchronous_commit_for(durability: str) -> str:
    return parse_durability_conf()[f"{durability}.pg_synchronous_commit"]


def redis_appendfsync_for(durability: str) -> str:
    return parse_durability_conf()[f"{durability}.redis_appendfsync"]


def pg_size_to_bytes(value: str) -> int:
    """Converts a PostgreSQL size (config-file or `SHOW` style: `1024MB`, `1GB`, `8kB`) to bytes."""
    m = _SIZE_RE.match(value.strip())
    if not m:
        raise ValueError(f"not a PostgreSQL size: {value!r}")
    number, unit = m.groups()
    try:
        mult = _PG_UNITS[unit.lower()]
    except KeyError:
        raise ValueError(f"unknown PostgreSQL size unit in {value!r}") from None
    return round(float(number) * mult)


def redis_size_to_bytes(value: str) -> int:
    """Converts a Redis memory size (`3072mb`, `1gb`, or a plain byte count) to bytes."""
    m = _SIZE_RE.match(value.strip())
    if not m:
        raise ValueError(f"not a Redis size: {value!r}")
    number, unit = m.groups()
    try:
        mult = _REDIS_UNITS[unit.lower()]
    except KeyError:
        raise ValueError(f"unknown Redis size unit in {value!r}") from None
    return round(float(number) * mult)


def expected_pg_settings(profile: str, durability: str) -> dict[str, str]:
    """Settings bench-postgres should report via `SHOW` for this (profile, durability)."""
    conf = parse_pg_conf(PG_DIR / f"{profile}.conf")
    return {
        "shared_buffers": conf["shared_buffers"],
        "effective_cache_size": conf["effective_cache_size"],
        "work_mem": conf["work_mem"],
        "maintenance_work_mem": conf["maintenance_work_mem"],
        "random_page_cost": conf["random_page_cost"],
        "effective_io_concurrency": conf["effective_io_concurrency"],
        "max_wal_size": conf["max_wal_size"],
        # bench.sh always overrides this on the command line, regardless of the file's own value.
        "synchronous_commit": pg_synchronous_commit_for(durability),
        # Neither profile may trade crash safety for speed: the durability comparison (strict vs
        # relaxed) is only about synchronous_commit vs appendfsync (fix round 1, ruling B6).
        "fsync": "on",
        "full_page_writes": "on",
    }


def pg_settings_equal(setting: str, actual: str, expected: str) -> bool:
    if setting in _PG_SIZE_SETTINGS:
        return pg_size_to_bytes(actual) == pg_size_to_bytes(expected)
    if setting in _PG_FLOAT_SETTINGS:
        return abs(float(actual) - float(expected)) < 1e-6
    if setting in _PG_INT_SETTINGS:
        return int(actual) == int(expected)
    return actual == expected


def expected_redis_settings(profile: str, durability: str) -> dict[str, str]:
    """Settings bench-redis should report via `CONFIG GET` for this (profile, durability)."""
    conf = parse_redis_conf(REDIS_DIR / f"{profile}.conf")
    return {
        "maxmemory": conf["maxmemory"],
        "maxmemory-policy": conf["maxmemory-policy"],
        "hash-max-listpack-entries": conf["hash-max-listpack-entries"],
        "hash-max-listpack-value": conf["hash-max-listpack-value"],
        "io-threads": conf["io-threads"],
        # bench.sh always passes these two on the command line, regardless of the file.
        "appendonly": "yes",
        "appendfsync": redis_appendfsync_for(durability),
    }


def redis_settings_equal(setting: str, actual: str, expected: str) -> bool:
    if setting == "maxmemory":
        return redis_size_to_bytes(actual) == redis_size_to_bytes(expected)
    return str(actual) == str(expected)


def current_profiles() -> dict[str, str]:
    """The live stand's profile/durability, as bench.sh passes them to bench-runner (from the
    `.env` that `up` wrote — ruling B3)."""
    return {
        "pg_profile": os.environ["PG_PROFILE"],
        "redis_profile": os.environ["REDIS_PROFILE"],
        "durability": os.environ["DURABILITY"],
    }


def write_load_meta(results_dir: Path, name: str) -> None:
    """Stamps a loader's result CSV (`<name>.csv`) with the profile/durability it was loaded
    under, so agrobench.run only ever files load time/size under the configuration they belong
    to (it refuses a stale load from another configuration)."""
    meta = {**current_profiles(), "finished_at": datetime.now(timezone.utc).isoformat()}
    Path(results_dir, f"{name}.meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
