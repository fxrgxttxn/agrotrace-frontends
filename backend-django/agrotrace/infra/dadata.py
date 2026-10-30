"""
DaData "findById/party" (spec FR-IAM-01, 8.9), the port of backend-express/src/infra/dadata.ts: the organization
behind an INN — name and address. Never blocks registration: no API key, a timeout (DADATA_TIMEOUT_MS per attempt), a
network error or a 5xx after 3 attempts (back-off 200, 400 ms) → `unavailable`, and the organization is saved as
MANUAL_CHECK; a 4xx (bad key, quota) is `unavailable` at once (decision 7 of Express Task 2).
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Literal

from agrotrace.core import config

log = logging.getLogger("agrotrace.dadata")
BACKOFF_S = 0.2


@dataclass(frozen=True)
class PartyLookup:
    status: Literal["found", "notFound", "unavailable"]
    name: str | None = None
    address: str | None = None


def js_slice(s: str, n: int) -> str:
    """`String.prototype.slice(0, n)` — counts UTF-16 code units (a split surrogate pair is dropped)."""
    units = s.encode("utf-16-le")
    if len(units) <= 2 * n:
        return s
    return units[: 2 * n].decode("utf-16-le", errors="ignore")


def _parse(data: object) -> PartyLookup:
    suggestions = data.get("suggestions") if isinstance(data, dict) else None
    s = suggestions[0] if isinstance(suggestions, list) and suggestions else None
    if not isinstance(s, dict):
        return PartyLookup("notFound")
    d = s.get("data") if isinstance(s.get("data"), dict) else {}
    names = d.get("name") if isinstance(d.get("name"), dict) else {}
    name = names.get("short_with_opf") or s.get("value") or names.get("full_with_opf")
    if not isinstance(name, str) or not name:
        return PartyLookup("notFound")
    addr = d.get("address") if isinstance(d.get("address"), dict) else {}
    address = addr.get("value") if isinstance(addr.get("value"), str) else None
    return PartyLookup("found", js_slice(name, 255), js_slice(address, 500) if address is not None else None)


def find_party(inn: str) -> PartyLookup:
    c = config.get()
    if not c.DADATA_API_KEY:
        return PartyLookup("unavailable")
    body = json.dumps({"query": inn, "count": 1}).encode()
    headers = {"content-type": "application/json", "accept": "application/json",
               "authorization": f"Token {c.DADATA_API_KEY}"}
    for attempt in range(1, 4):
        try:
            req = urllib.request.Request(c.DADATA_URL, data=body, method="POST", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=c.DADATA_TIMEOUT_MS / 1000) as res:
                    return _parse(json.loads(res.read().decode("utf-8")))
            except urllib.error.HTTPError as e:
                if 400 <= e.code < 500:
                    log.warning("dadata rejected the request", extra={"status": e.code})
                    return PartyLookup("unavailable")
                raise RuntimeError(f"dadata status {e.code}") from None
        except Exception as e:  # timeouts, network errors, 5xx, a body that is not JSON
            log.warning("dadata unavailable", extra={"err": str(e), "attempt": attempt})
            if attempt < 3:
                time.sleep(BACKOFF_S * 2 ** (attempt - 1))
    return PartyLookup("unavailable")


def check_inn(inn: str) -> Literal["PENDING", "MANUAL_CHECK"]:
    """The status a registration gets from DaData alone (found → PENDING, otherwise MANUAL_CHECK)."""
    return "PENDING" if find_party(inn).status == "found" else "MANUAL_CHECK"
