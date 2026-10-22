"""
ФГИС «Меркурий» adapter (R81; dev: mercury-mock, `MERCURY_URL`), the port of backend-express/src/infra/mercury.ts: one
list query per call, `GET {MERCURY_URL}/api/v1/vsd?productCode=&senderInn=&dateFrom=&dateTo=`, `MERCURY_TIMEOUT_MS`
(10 s) per call. A call either returns the parsed `items` or fails (network error, timeout, a status other than 200, a
body that is not the Mercury format); the retry policy belongs to the `vsd.import` handler. No database work happens
here — the handler calls it with no connection held (P61).

Test stand only (P35): calls for a product code listed in `MERCURY_FAIL_PRODUCT_CODES` carry `X-Mock-Fail:
<MERCURY_FAIL_MODE>`, so mercury-mock fails them on purpose. The settings are read once, when the worker starts.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from agrotrace.core.patterns import ecma

_UUID = ecma(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_DATE = ecma(r"^\d{4}-\d{2}-\d{2}$")
_INN = ecma(r"^\d{10}(\d{2})?$")
_STATUSES = ("CONFIRMED", "WITHDRAWN", "UTILIZED")


@dataclass(frozen=True)
class VsdQuery:
    product_code: str
    sender_inn: str
    date_from: str
    date_to: str


@dataclass(frozen=True)
class VsdCall:
    ok: bool
    items: list[dict[str, Any]] = field(default_factory=list)
    error: str = ""


def _str(v: Any) -> bool:
    return isinstance(v, str)


def _party(v: Any) -> bool:
    return isinstance(v, dict) and _str(v.get("inn")) and _INN.search(v["inn"]) is not None and _str(v.get("name"))


def is_vsd(v: Any) -> bool:
    """The Mercury document format (Express `VsdSchema`; extra fields are kept in the payload)."""
    if not isinstance(v, dict):
        return False
    number = v.get("number")
    product = v.get("product")
    volume = v.get("volume")
    value = volume.get("value") if isinstance(volume, dict) else None
    return (_str(v.get("uuid")) and _UUID.search(v["uuid"]) is not None
            and _str(number) and 1 <= len(number) <= 64
            and _str(v.get("issueDate")) and _DATE.search(v["issueDate"]) is not None
            and v.get("status") in _STATUSES
            and isinstance(product, dict) and _str(product.get("code")) and _str(product.get("name"))
            and isinstance(volume, dict) and isinstance(value, (int, float)) and not isinstance(value, bool)
            and value >= 0 and _str(volume.get("unit"))
            and _party(v.get("consignor")) and _party(v.get("consignee")))


def normalized(v: dict[str, Any]) -> dict[str, Any]:
    """The parsed document as Express keeps it (Zod `passthrough` at the top level only): unknown top-level fields
    (vetInspection …) stay, the nested objects keep only their known fields."""
    return {**v,
            "product": {"code": v["product"]["code"], "name": v["product"]["name"]},
            "volume": {"value": v["volume"]["value"], "unit": v["volume"]["unit"]},
            "consignor": {"inn": v["consignor"]["inn"], "name": v["consignor"]["name"]},
            "consignee": {"inn": v["consignee"]["inn"], "name": v["consignee"]["name"]}}


class Mercury:
    def __init__(self, *, url: str, timeout_ms: int, fail_product_codes: tuple[str, ...] = (),
                 fail_mode: str = "500"):
        self.url = url.rstrip("/")
        self.timeout_s = timeout_ms / 1000
        self.fail_product_codes = fail_product_codes
        self.fail_mode = fail_mode

    def request(self, q: VsdQuery) -> urllib.request.Request:
        query = urllib.parse.urlencode({"productCode": q.product_code, "senderInn": q.sender_inn,
                                        "dateFrom": q.date_from, "dateTo": q.date_to})
        headers = {"accept": "application/json"}
        if q.product_code in self.fail_product_codes:
            headers["X-Mock-Fail"] = self.fail_mode
        return urllib.request.Request(f"{self.url}/api/v1/vsd?{query}", headers=headers, method="GET")

    def list_vsd(self, q: VsdQuery) -> VsdCall:
        try:
            with urllib.request.urlopen(self.request(q), timeout=self.timeout_s) as res:  # noqa: S310 - config URL
                if res.status != 200:
                    return VsdCall(False, error=f"mercury: HTTP {res.status}")
                data = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return VsdCall(False, error=f"mercury: HTTP {e.code}")
        except TimeoutError:
            return VsdCall(False, error=f"mercury: timeout after {round(self.timeout_s * 1000)} ms")
        except urllib.error.URLError as e:
            reason = e.reason
            if isinstance(reason, TimeoutError):
                return VsdCall(False, error=f"mercury: timeout after {round(self.timeout_s * 1000)} ms")
            return VsdCall(False, error=f"mercury: {reason}")
        except (ValueError, OSError) as e:  # a body that is not JSON / UTF-8, a reset connection
            return VsdCall(False, error=f"mercury: {e}")
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return VsdCall(False, error="mercury: the response is not a VSD list")
        if not all(is_vsd(v) for v in items):
            return VsdCall(False, error="mercury: a VSD item does not match the Mercury format")
        return VsdCall(True, items=[normalized(v) for v in items])


def from_config() -> Mercury:
    from agrotrace.core import config

    c = config.get()
    return Mercury(url=c.MERCURY_URL, timeout_ms=c.MERCURY_TIMEOUT_MS, fail_product_codes=c.MERCURY_FAIL_PRODUCT_CODES,
                   fail_mode=c.MERCURY_FAIL_MODE)


def pick_vsd(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The document to import: among CONFIRMED items the latest — greatest issueDate, then number, then uuid (code-point
    order); none → None."""
    best: dict[str, Any] | None = None
    for v in items:
        if v.get("status") != "CONFIRMED":
            continue
        if best is None or (v["issueDate"], v["number"], v["uuid"]) > (best["issueDate"], best["number"], best["uuid"]):
            best = v
    return best
