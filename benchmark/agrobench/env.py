"""Writes benchmark/results/env.json: stand characteristics (spec §13.4, §13.6) — CPU/RAM/disk as
visible inside bench-runner, OS, Docker/Compose versions (passed in by bench.sh, which is the
only place with host `docker` access), PostgreSQL/Redis/Python/library versions, the active
profiles, and the resource limits actually applied to both DBMS containers (introspected by
bench.sh via `docker inspect` and passed in as PG_LIMITS_*/REDIS_LIMITS_* — this module has no
docker socket of its own, so it never re-declares agrobench.config.RESOURCE_LIMITS as fact).

Run via `./at.sh bench env` (also invoked automatically at the end of `./at.sh bench up`).
"""
from __future__ import annotations

import json
import os
import platform
import shutil
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path

import psycopg
import redis

from agrobench import config


def _cpu_count() -> int | None:
    return os.cpu_count()


def _mem_total_mb() -> float | None:
    try:
        with open("/proc/meminfo", encoding="ascii") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    return None


def _disk_free_gb(path: str) -> float | None:
    try:
        return round(shutil.disk_usage(path).free / (1024**3), 2)
    except OSError:
        return None


def _lib_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _pg_version() -> str | None:
    try:
        with psycopg.connect(connect_timeout=5) as conn, conn.cursor() as cur:
            cur.execute("SHOW server_version")
            return cur.fetchone()[0]
    except psycopg.OperationalError:
        return None


def _redis_version() -> str | None:
    try:
        client = redis.Redis.from_url(os.environ["REDIS_URL"], socket_connect_timeout=5)
        return client.info("server").get("redis_version")
    except (redis.RedisError, KeyError, OSError):
        return None


def _container_limits(cpus_env: str, mem_bytes_env: str) -> dict:
    """Converts docker inspect's raw HostConfig fields (NanoCpus, Memory in bytes — both 0 if
    unset) into the same {"cpus", "mem_mb"} shape as agrobench.config.RESOURCE_LIMITS, so the two
    are directly comparable."""
    nano_cpus = os.environ.get(cpus_env, "")
    mem_bytes = os.environ.get(mem_bytes_env, "")
    cpus = round(int(nano_cpus) / 1e9, 3) if nano_cpus not in ("", "0") else None
    mem_mb = round(int(mem_bytes) / (1024**2), 1) if mem_bytes not in ("", "0") else None
    return {"cpus": cpus, "mem_mb": mem_mb}


def collect() -> dict:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "host": {
            "os": platform.platform(),
            "cpu_count_visible_to_runner": _cpu_count(),
            "mem_total_mb_visible_to_runner": _mem_total_mb(),
            "disk_free_gb": _disk_free_gb(str(config.BENCH_DIR)),
        },
        "docker": {
            "docker_version": os.environ.get("DOCKER_VERSION") or None,
            "compose_version": os.environ.get("DOCKER_COMPOSE_VERSION") or None,
        },
        "versions": {
            "python": platform.python_version(),
            "postgres": _pg_version(),
            "redis": _redis_version(),
            "psycopg": _lib_version("psycopg"),
            "redis_py": _lib_version("redis"),
            "numpy": _lib_version("numpy"),
            "matplotlib": _lib_version("matplotlib"),
            "pytest": _lib_version("pytest"),
            "ruff": _lib_version("ruff"),
        },
        "profiles": {
            "pg_profile": os.environ.get("PG_PROFILE", "default"),
            "redis_profile": os.environ.get("REDIS_PROFILE", "default"),
            "durability": os.environ.get("DURABILITY", "relaxed"),
        },
        # Introspected from the running containers (docker inspect .HostConfig, via bench.sh —
        # see module docstring), not just repeated from agrobench.config.RESOURCE_LIMITS.
        # Identical for both DBMS by construction (docker-compose.yml `cpus`/`mem_limit`) —
        # tests/test_env.py asserts the two entries match each other AND the declared config.
        "resource_limits": {
            "postgres": _container_limits("PG_LIMITS_CPUS", "PG_LIMITS_MEM_BYTES"),
            "redis": _container_limits("REDIS_LIMITS_CPUS", "REDIS_LIMITS_MEM_BYTES"),
        },
    }


def main() -> None:
    results_dir = Path(os.environ.get("RESULTS_DIR", str(config.BENCH_DIR / "results")))
    results_dir.mkdir(parents=True, exist_ok=True)
    data = collect()
    (results_dir / "env.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(data, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
