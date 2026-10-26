"""
The api process (`python -m agrotrace.serve`, docker-compose api-django): uvicorn on PORT (8000) with one worker, no
access log of its own (core.middleware.AccessLogMiddleware logs requests), no Server header, and in-flight requests
given SHUTDOWN_TIMEOUT_MS on SIGTERM — the PORT and SHUTDOWN_TIMEOUT_MS of backend-express/src/main-api.ts. A bad
configuration exits 78 (EX_CONFIG) before anything listens, as Express's `configOrExit`.
"""

from __future__ import annotations

import sys
from typing import Any

from agrotrace.core import config


def uvicorn_options(cfg: config.Config) -> dict[str, Any]:
    return {
        "host": "0.0.0.0",  # noqa: S104 - inside the `at` network; the gateway proxies to it
        "port": cfg.PORT,
        "workers": 1,
        "access_log": False,
        "server_header": False,
        "timeout_graceful_shutdown": cfg.SHUTDOWN_TIMEOUT_MS / 1000,
    }


def main() -> None:
    try:
        cfg = config.get()
    except config.ConfigError as e:
        sys.stderr.write(f"agrotrace-django: {e}\n")
        sys.exit(78)
    import uvicorn

    uvicorn.run("agrotrace.asgi:application", **uvicorn_options(cfg))


if __name__ == "__main__":
    main()
