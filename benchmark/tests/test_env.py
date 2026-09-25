"""After `./at.sh bench up <pg_profile> <redis_profile> <durability>`, the live containers must
actually be running with those parameters — not just declare them (spec Global Constraints:
"честность замеров"; Task 1 brief). Checked against real `SHOW`/`CONFIG GET` output, not against
what bench.sh *intended* to pass.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import psycopg
import pytest
import redis

from agrobench import config


def _pg_connect():
    return psycopg.connect(connect_timeout=5)


def _redis_client():
    return redis.Redis.from_url(os.environ["REDIS_URL"], decode_responses=True, socket_connect_timeout=5)


def test_postgres_live_settings_match_profile_and_durability():
    profile = os.environ.get("PG_PROFILE", "default")
    durability = os.environ.get("DURABILITY", "relaxed")
    expected = config.expected_pg_settings(profile, durability)

    with _pg_connect() as conn, conn.cursor() as cur:
        for setting, expected_value in expected.items():
            cur.execute(f"SHOW {setting}")
            actual = cur.fetchone()[0]
            assert config.pg_settings_equal(setting, actual, expected_value), (
                f"PostgreSQL {setting}: expected {expected_value!r} (profile={profile}, "
                f"durability={durability}), got {actual!r}"
            )


def test_redis_live_settings_match_profile_and_durability():
    profile = os.environ.get("REDIS_PROFILE", "default")
    durability = os.environ.get("DURABILITY", "relaxed")
    expected = config.expected_redis_settings(profile, durability)

    client = _redis_client()
    for setting, expected_value in expected.items():
        actual = client.config_get(setting)[setting]
        assert config.redis_settings_equal(setting, actual, expected_value), (
            f"Redis {setting}: expected {expected_value!r} (profile={profile}, "
            f"durability={durability}), got {actual!r}"
        )


def test_pg_settings_differ_between_default_and_tuned_profiles():
    # Guards against the two profile files accidentally being identical (which would make the
    # two tests above pass for the wrong reason).
    default = config.expected_pg_settings("default", "relaxed")
    tuned = config.expected_pg_settings("tuned", "relaxed")
    assert config.pg_size_to_bytes(default["shared_buffers"]) < config.pg_size_to_bytes(tuned["shared_buffers"])


def test_redis_settings_differ_between_default_and_tuned_profiles():
    default = config.expected_redis_settings("default", "relaxed")
    tuned = config.expected_redis_settings("tuned", "relaxed")
    assert default["hash-max-listpack-entries"] != tuned["hash-max-listpack-entries"]


def test_durability_flips_pg_synchronous_commit_and_redis_appendfsync():
    strict = config.expected_pg_settings("default", "strict")
    relaxed = config.expected_pg_settings("default", "relaxed")
    assert strict["synchronous_commit"] == "on"
    assert relaxed["synchronous_commit"] == "off"

    strict_r = config.expected_redis_settings("default", "strict")
    relaxed_r = config.expected_redis_settings("default", "relaxed")
    assert strict_r["appendfsync"] == "always"
    assert relaxed_r["appendfsync"] == "everysec"


def test_env_json_records_identical_resource_limits_for_both_dbms():
    results_dir = Path(os.environ.get("RESULTS_DIR", str(config.BENCH_DIR / "results")))
    env_path = results_dir / "env.json"
    assert env_path.exists(), "results/env.json missing — run ./at.sh bench env (or up) first"
    data = json.loads(env_path.read_text(encoding="utf-8"))

    limits = data["resource_limits"]
    assert limits["postgres"] == limits["redis"] == config.RESOURCE_LIMITS
    assert data["profiles"]["pg_profile"] == os.environ.get("PG_PROFILE", "default")
    assert data["profiles"]["redis_profile"] == os.environ.get("REDIS_PROFILE", "default")
    assert data["profiles"]["durability"] == os.environ.get("DURABILITY", "relaxed")
    for key in ("postgres", "redis", "python"):
        assert data["versions"][key], f"versions.{key} not recorded in env.json"


@pytest.mark.parametrize("profile", ["default", "tuned"])
def test_conf_files_parse_cleanly(profile):
    pg = config.parse_pg_conf(config.PG_DIR / f"{profile}.conf")
    assert pg["listen_addresses"] == "*"
    redis_conf = config.parse_redis_conf(config.REDIS_DIR / f"{profile}.conf")
    assert redis_conf["maxmemory-policy"] == "noeviction"
