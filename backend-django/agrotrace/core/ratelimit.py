"""
Rate limits (R30, contracts/rules/rate-limits.json, P10/P41), the port of backend-express/src/http/rate-limit.ts:
fixed-window counters in the shared Redis. Each hit: `INCR rl:{scope}:{subject}:{windowStartEpochSec}` and
`EXPIRE … windowSec NX` in one MULTI (a counter never lives without a TTL); over the limit → 429 RATE_LIMITED,
`Retry-After` = seconds to the window end (≥ 1), `params {scope, limit, windowSec}`. `RATE_LIMIT_OVERRIDES` replaces
only `limit`. The `user` scope counts every Bearer-authenticated request (ContractView); the IP scopes of
`x-rate-limit` are counted by ContractView before the operation's own checks; `forgot` (subject: the lower-cased email
of the body) by its operation.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from functools import cache

from agrotrace.core import config
from agrotrace.core.problem import AppProblem


@dataclass(frozen=True)
class Limit:
    scope: str
    limit: int
    window_sec: int
    subject: str


@cache
def _limits() -> dict[str, Limit]:
    rules = json.loads((config.ROOT / "contracts" / "rules" / "rate-limits.json").read_text("utf-8"))
    return {r["scope"]: Limit(r["scope"], r["limit"], r["windowSec"], r["subject"]) for r in rules["limits"]}


def limit_of(scope: str) -> Limit:
    base = _limits()[scope]
    override = config.get().RATE_LIMIT_OVERRIDES.get(scope)
    return base if override is None else Limit(base.scope, override, base.window_sec, base.subject)


def hit(scope: str, subject: str, now: float | None = None) -> None:
    """Counts one request of `subject` in `scope`; raises 429 when this request is over the limit."""
    from agrotrace.infra import redis

    lim = limit_of(scope)
    now_sec = int(time.time() if now is None else now)
    window_start = now_sec // lim.window_sec * lim.window_sec
    key = f"rl:{scope}:{subject}:{window_start}"
    pipe = redis.client().pipeline(transaction=True)
    pipe.incr(key)
    pipe.expire(key, lim.window_sec, nx=True)
    count = int(pipe.execute()[0])
    if count > lim.limit:
        retry_after = max(1, window_start + lim.window_sec - now_sec)
        raise AppProblem(429, "RATE_LIMITED", params={"scope": scope, "limit": lim.limit, "windowSec": lim.window_sec},
                         headers={"Retry-After": str(retry_after)})
