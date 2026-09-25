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


def _cpu_model() -> str | None:
    """CPU model as the (shared) kernel reports it — the host CPU under Docker Desktop's VM."""
    try:
        with open("/proc/cpuinfo", encoding="ascii", errors="replace") as f:
            for line in f:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return None


def _disk(path: str) -> dict:
    """Size/free space and filesystem of the mount holding `path` (the bind-mounted benchmark
    dir); the DBMS data lives in named Docker volumes on the same Docker VM disk."""
    out: dict = {"path": path}
    try:
        usage = shutil.disk_usage(path)
        out["total_gb"] = round(usage.total / (1024**3), 2)
        out["free_gb"] = round(usage.free / (1024**3), 2)
    except OSError:
        pass
    try:
        best = ""
        with open("/proc/mounts", encoding="ascii", errors="replace") as f:
            for line in f:
                device, mount, fstype = line.split()[:3]
                if path.startswith(mount) and len(mount) > len(best):
                    best = mount
                    out.update({"mount": mount, "fstype": fstype, "device": device})
    except OSError:
        pass
    return out


def _df_line(env_name: str) -> dict | None:
    """Parses one `df -kT` data line (device, fstype, 1K-blocks, used, available, use%, mount)
    passed in by bench.sh from inside a DBMS container."""
    line = os.environ.get(env_name, "").removeprefix("df ").split()  # prefix: see bench.sh
    if len(line) < 7:
        return None
    device, fstype, total_k, used_k, avail_k = line[:5]
    try:
        return {
            "device": device, "fstype": fstype,
            "total_gb": round(int(total_k) / 1024**2, 2), "used_gb": round(int(used_k) / 1024**2, 2),
            "free_gb": round(int(avail_k) / 1024**2, 2),
        }
    except ValueError:
        return {"raw": " ".join(line)}


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
            "cpu_model": _cpu_model(),
            "cpu_count_visible_to_runner": _cpu_count(),
            "mem_total_mb_visible_to_runner": _mem_total_mb(),
            # The /bench bind mount as the runner sees it (where results/ and data/ CSVs live) —
            # NOT where the DBMS keep their data; that is db_data_disk below.
            "bench_mount_disk_free_gb": _disk_free_gb(str(config.BENCH_DIR)),
            "bench_mount_disk": _disk(str(config.BENCH_DIR)),
        },
        # Filesystem holding each DBMS's data: its named Docker volume inside the Docker VM, as `df`
        # sees it from inside the container (passed in by bench.sh), plus the engine's data-root.
        "db_data_disk": {
            "docker_root_dir": os.environ.get("DOCKER_ROOT_DIR", "").removeprefix("root ") or None,
            "postgres": _df_line("PG_DATA_DF"),
            "redis": _df_line("REDIS_DATA_DF"),
        },
        "docker": {
            "docker_version": os.environ.get("DOCKER_VERSION") or None,
            "compose_version": os.environ.get("DOCKER_COMPOSE_VERSION") or None,
            # `docker info` summary from the host (bench.sh): engine OS, kernel, storage driver,
            # CPUs and memory of the Docker VM.
            "engine": os.environ.get("DOCKER_INFO") or None,
        },
        "versions": {
            "python": platform.python_version(),
            "postgres": _pg_version(),
            "redis": _redis_version(),
            "psycopg": _lib_version("psycopg"),
            "redis_py": _lib_version("redis"),
            "hiredis": _lib_version("hiredis"),
            "psycopg_binary": _lib_version("psycopg-binary"),
            "psycopg_pool": _lib_version("psycopg-pool"),
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
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    (results_dir / "env.json").write_text(text, encoding="utf-8")
    # One copy per configuration (fix round 1): `all` brings the stand up four times and the
    # plain env.json only keeps the last one.
    p = data["profiles"]
    per_config = results_dir / "env" / f"env_pg-{p['pg_profile']}_redis-{p['redis_profile']}_{p['durability']}.json"
    per_config.parent.mkdir(parents=True, exist_ok=True)
    per_config.write_text(text, encoding="utf-8")
    print(json.dumps(data, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
