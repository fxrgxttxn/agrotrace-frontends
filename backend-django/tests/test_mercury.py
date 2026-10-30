"""The Mercury adapter (infra.mercury) and the `vsd.import` handler's call policy (events/handlers/vsd_import.py):
the pauses MERCURY_RETRY_BASE_MS × 2ⁿ between the 6 calls, `X-Mock-Fail` only for the configured product codes, the
10 s timeout per call, and the document chosen — the latest CONFIRMED one of the window harvestedAt ± 3 days."""

from __future__ import annotations

import http.server
import json
import threading
import time
from datetime import UTC, datetime

import pytest

from agrotrace.core import config
from agrotrace.events.handlers import vsd_import
from agrotrace.infra import mercury
from agrotrace.infra.mercury import Mercury, VsdCall, VsdQuery


def _doc(number: str, issue: str, status: str = "CONFIRMED", uuid: str = "d3bc6508-f9e7-412e-a6c4-690f31cd59f0"):
    return {"uuid": uuid, "number": number, "issueDate": issue, "status": status,
            "product": {"code": "10.11.11", "name": "Говядина", "extra": 1}, "volume": {"value": 10.5, "unit": "кг"},
            "consignor": {"inn": "502701234075", "name": "КФХ"}, "consignee": {"inn": "7705120028", "name": "ООО"},
            "vetInspection": {"result": "HEALTHY"}}


class FakeMercury:
    def __init__(self, answers):
        self.answers = list(answers)
        self.queries: list[VsdQuery] = []

    def list_vsd(self, q):
        self.queries.append(q)
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]


@pytest.fixture
def handler(monkeypatch):
    """import_vsd with the database steps replaced by recorders."""
    seen: dict = {"failures": [], "finish": None, "claimed": []}
    monkeypatch.setattr(vsd_import, "already_claimed", lambda event_id: False)
    monkeypatch.setattr(vsd_import, "_source", lambda doc_id: {
        "id": doc_id, "import_status": "PENDING", "mercury_code": "10.11.11", "inn": "502701234075",
        "harvested_at": datetime(2026, 3, 1, 23, 30, tzinfo=UTC)})
    monkeypatch.setattr(vsd_import, "_record_failure", lambda doc_id, err: seen["failures"].append(err))
    monkeypatch.setattr(vsd_import, "_finish", lambda event_id, doc_id, outcome: seen.__setitem__("finish", outcome))
    monkeypatch.setattr(vsd_import, "_claim_only", lambda event_id: seen["claimed"].append(event_id))
    return seen


EVENT = {"id": "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", "type": "vsd.import",
         "data": {"documentId": "4e6a8c0e-2a4c-4e6a-8c0e-2a4c6e8a0c2e", "batchId": "x", "publicCode": "AT-2026-000123"}}


def test_six_calls_with_doubling_pauses_then_failed(handler):
    sleeps: list[float] = []
    fake = FakeMercury([VsdCall(False, error="mercury: HTTP 500")])
    vsd_import.import_vsd(EVENT, client=fake, retry_base_ms=2000, sleep=sleeps.append)
    assert len(fake.queries) == 6
    assert sleeps == [2.0, 4.0, 8.0, 16.0, 32.0]
    assert handler["failures"] == ["mercury: HTTP 500"] * 5  # the 6th is counted by the final transaction
    assert handler["finish"].status == "FAILED" and handler["finish"].calls == 6
    assert handler["finish"].error == "mercury: HTTP 500"


def test_the_stand_base_shortens_the_pauses(handler):
    sleeps: list[float] = []
    fake = FakeMercury([VsdCall(False, error="e")])
    vsd_import.import_vsd(EVENT, client=fake, retry_base_ms=50, sleep=sleeps.append)
    assert sleeps == [0.05, 0.1, 0.2, 0.4, 0.8]


def test_the_window_and_the_latest_confirmed_document(handler):
    items = [_doc("VSD-1", "2026-02-27"), _doc("VSD-9", "2026-03-04", status="WITHDRAWN"),
             _doc("VSD-2", "2026-03-02"), _doc("VSD-3", "2026-03-02", uuid="00000000-0000-4000-8000-000000000001")]
    fake = FakeMercury([VsdCall(False, error="e"), VsdCall(True, items=[mercury.normalized(i) for i in items])])
    vsd_import.import_vsd(EVENT, client=fake, retry_base_ms=1, sleep=lambda s: None)
    q = fake.queries[0]
    # harvestedAt 2026-03-01T23:30Z → the UTC date 2026-03-01 ∓ 3 days, inclusive.
    assert (q.product_code, q.sender_inn, q.date_from, q.date_to) == ("10.11.11", "502701234075", "2026-02-26",
                                                                      "2026-03-04")
    out = handler["finish"]
    assert out.status == "IMPORTED" and out.calls == 2 and out.vsd["number"] == "VSD-3"
    assert out.vsd["product"] == {"code": "10.11.11", "name": "Говядина"}  # nested extras dropped (Zod strip)
    assert out.vsd["vetInspection"] == {"result": "HEALTHY"}  # top-level extras kept (passthrough)


def test_no_confirmed_document_is_not_found_after_one_call(handler):
    fake = FakeMercury([VsdCall(True, items=[_doc("VSD-1", "2026-03-01", status="UTILIZED")])])
    vsd_import.import_vsd(EVENT, client=fake, retry_base_ms=1, sleep=lambda s: None)
    assert handler["finish"].status == "NOT_FOUND" and handler["finish"].calls == 1


def test_no_mercury_code_is_not_found_without_a_call(handler, monkeypatch):
    monkeypatch.setattr(vsd_import, "_source", lambda doc_id: {
        "id": doc_id, "import_status": "PENDING", "mercury_code": None, "inn": "502701234075",
        "harvested_at": datetime(2026, 3, 1, tzinfo=UTC)})
    fake = FakeMercury([VsdCall(True)])
    vsd_import.import_vsd(EVENT, client=fake)
    assert fake.queries == [] and handler["finish"].status == "NOT_FOUND" and handler["finish"].calls == 0


def test_a_row_no_longer_pending_is_only_claimed(handler, monkeypatch):
    monkeypatch.setattr(vsd_import, "_source", lambda doc_id: {"id": doc_id, "import_status": "IMPORTED"})
    fake = FakeMercury([VsdCall(True)])
    vsd_import.import_vsd(EVENT, client=fake)
    assert fake.queries == [] and handler["claimed"] == [EVENT["id"]] and handler["finish"] is None


def test_x_mock_fail_only_for_the_configured_codes():
    m = Mercury(url="http://mercury-mock:8080/", timeout_ms=10000, fail_product_codes=("99.99.99",),
                fail_mode="timeout")
    failing = m.request(VsdQuery("99.99.99", "502701234075", "2026-02-26", "2026-03-04"))
    normal = m.request(VsdQuery("10.11.11", "502701234075", "2026-02-26", "2026-03-04"))
    assert failing.get_header("X-mock-fail") == "timeout"
    assert normal.get_header("X-mock-fail") is None
    assert normal.full_url == ("http://mercury-mock:8080/api/v1/vsd?productCode=10.11.11&senderInn=502701234075"
                               "&dateFrom=2026-02-26&dateTo=2026-03-04")


def test_the_worker_reads_the_settings_at_start():
    c = config.load({"APP_DATABASE_URL": "postgres://u:p@h/d", "REDIS_URL": "redis://h",
                     "RABBITMQ_URL": "amqp://h", "S3_ENDPOINT": "http://h", "S3_ACCESS_KEY": "a", "S3_SECRET_KEY": "b",
                     "S3_BUCKET": "c", "JWT_SECRET": "x" * 32, "PUBLIC_BASE_URL": "http://h"})
    assert c.MERCURY_TIMEOUT_MS == 10000 and c.MERCURY_RETRY_BASE_MS == 2000 and c.MERCURY_FAIL_PRODUCT_CODES == ()
    live = config.get()
    assert vsd_import._client.timeout_s == live.MERCURY_TIMEOUT_MS / 1000
    assert vsd_import._client.fail_product_codes == live.MERCURY_FAIL_PRODUCT_CODES
    assert vsd_import._retry_base_ms == live.MERCURY_RETRY_BASE_MS


class _Server:
    def __init__(self, handler_fn):
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                outer.headers = dict(self.headers)
                handler_fn(self)

            def log_message(self, *args):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def _reply(status: int, body: bytes):
    def fn(h):
        h.send_response(status)
        h.send_header("content-type", "application/json")
        h.send_header("content-length", str(len(body)))
        h.end_headers()
        h.wfile.write(body)
    return fn


Q = VsdQuery("10.11.11", "502701234075", "2026-02-26", "2026-03-04")


def test_http_outcomes():
    ok = _Server(_reply(200, json.dumps({"items": [_doc("VSD-1", "2026-03-01")]}).encode()))
    bad_status = _Server(_reply(503, b"{}"))
    bad_shape = _Server(_reply(200, json.dumps({"items": [{"uuid": "nope"}]}).encode()))
    not_list = _Server(_reply(200, b'{"rows": []}'))
    try:
        r = Mercury(url=ok.url, timeout_ms=2000).list_vsd(Q)
        assert r.ok and r.items[0]["number"] == "VSD-1" and r.items[0]["product"] == {"code": "10.11.11",
                                                                                         "name": "Говядина"}
        assert ok.headers.get("Accept") == "application/json"
        assert Mercury(url=bad_status.url, timeout_ms=2000).list_vsd(Q).error == "mercury: HTTP 503"
        assert Mercury(url=bad_shape.url, timeout_ms=2000).list_vsd(Q).error == \
            "mercury: a VSD item does not match the Mercury format"
        assert Mercury(url=not_list.url, timeout_ms=2000).list_vsd(Q).error == "mercury: the response is not a VSD list"
    finally:
        for s in (ok, bad_status, bad_shape, not_list):
            s.close()


def test_the_timeout_bounds_one_call():
    slow = _Server(lambda h: (time.sleep(1.5), _reply(200, b'{"items": []}')(h)))
    try:
        t0 = time.monotonic()
        r = Mercury(url=slow.url, timeout_ms=300).list_vsd(Q)
        assert not r.ok and r.error == "mercury: timeout after 300 ms"
        assert time.monotonic() - t0 < 1.2
    finally:
        slow.close()
    assert Mercury(url="http://127.0.0.1:9", timeout_ms=10000).timeout_s == 10.0
    refused = Mercury(url="http://127.0.0.1:9", timeout_ms=500).list_vsd(Q)
    assert not refused.ok and refused.error.startswith("mercury: ")


def test_pick_vsd_order():
    a = _doc("VSD-1", "2026-03-02", uuid="00000000-0000-4000-8000-00000000000a")
    b = _doc("VSD-1", "2026-03-02", uuid="00000000-0000-4000-8000-00000000000b")
    c = _doc("VSD-0", "2026-03-03", status="WITHDRAWN")
    assert mercury.pick_vsd([a, b, c])["uuid"].endswith("b")
    assert mercury.pick_vsd([c]) is None
    assert mercury.pick_vsd([]) is None
