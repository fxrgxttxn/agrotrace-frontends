"""
The shared Redis (keys of the contract table, R82/R92/P9): redis-py WITHOUT any key prefix, serializer or compression
(port-globals §2) — `idem:`, `rl:`, `pub:batch:`, … are the same keys the other implementations read and write.
One client (thread-safe connection pool) per process.
"""

from __future__ import annotations

import threading

import redis

from agrotrace.core import config

_lock = threading.Lock()
_client: redis.Redis | None = None


def client() -> redis.Redis:
    global _client
    if _client is None:
        with _lock:
            if _client is None:
                _client = redis.Redis.from_url(
                    config.get().REDIS_URL, socket_timeout=5, socket_connect_timeout=5, health_check_interval=30
                )
    return _client
