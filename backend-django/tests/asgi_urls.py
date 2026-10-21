"""Test-only routes for test_asgi_concurrency.py: the application's routes plus synchronous probe views under
/api/v1/test/ (not contract paths)."""

import threading
import time

from django.urls import path
from rest_framework.response import Response

from agrotrace.core import sql
from agrotrace.core.context import client_gone
from agrotrace.core.views import ContractView
from agrotrace.urls import urlpatterns as app_urlpatterns

RECORD: dict[str, object] = {}
LOCK = threading.Lock()


class Probe(ContractView):
    operation_id = "getHealthLive"  # public: no authentication


class Sleep(Probe):
    def get(self, request):
        time.sleep(0.5)
        return Response({"slept": True})


class DbSleep(Probe):
    def get(self, request):
        sql.scalar("SELECT pg_sleep(0.5)")
        with LOCK:
            RECORD["db_done"] = int(RECORD.get("db_done", 0)) + 1
        return Response({"ok": True})


class Gone(Probe):
    def get(self, request):
        time.sleep(0.4)
        RECORD[request.META["HTTP_X_PROBE"]] = client_gone()
        return Response({"ok": True})


urlpatterns = [
    *app_urlpatterns,
    path("api/v1/test/sleep", Sleep.as_view()),
    path("api/v1/test/db-sleep", DbSleep.as_view()),
    path("api/v1/test/gone", Gone.as_view()),
]

handler404 = "agrotrace.core.problem.handler404"
handler500 = "agrotrace.core.problem.handler500"
