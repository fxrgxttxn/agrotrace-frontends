"""Test-only routes for test_idempotency.py: ContractView probes under /api/v1/test/idem/ that run the
`createWaybill` operation's x-idempotent protocol (authentication is patched by the test) and answer with bodies
holding a Decimal and a datetime, an error, a crash, or a 2xx that cannot be rendered."""

from datetime import UTC, datetime
from decimal import Decimal

from django.urls import path
from rest_framework.response import Response

from agrotrace.core.problem import AppProblem
from agrotrace.core.views import ContractView
from agrotrace.urls import urlpatterns as app_urlpatterns

CALLS: list[str] = []


class _Idem(ContractView):
    operation_id = "createWaybill"


class Typed(_Idem):
    def post(self, request):
        CALLS.append("typed")
        return Response({"mass": Decimal("12480.500"), "at": datetime(2026, 9, 24, 8, 30, 0, 123456, tzinfo=UTC),
                         "name": "КФХ «Петров»", "n": [1, 2.5, None, True]}, status=201)


class Fails(_Idem):
    def post(self, request):
        CALLS.append("fails")
        raise AppProblem(409, "INVALID_TRANSITION", params={"from": "SENT", "to": "SENT"})


class Crashes(_Idem):
    def post(self, request):
        CALLS.append("crashes")
        raise RuntimeError("boom")


class Unrenderable(_Idem):
    """A 2xx whose data the renderer cannot serialize (a programming error): the render fails in finalize_response."""

    def post(self, request):
        CALLS.append("unrenderable")
        return Response({"x": object()}, status=201)


urlpatterns = [
    *app_urlpatterns,
    path("api/v1/test/idem/typed", Typed.as_view()),
    path("api/v1/test/idem/fails", Fails.as_view()),
    path("api/v1/test/idem/crashes", Crashes.as_view()),
    path("api/v1/test/idem/unrenderable", Unrenderable.as_view()),
]

handler404 = "agrotrace.core.problem.handler404"
handler500 = "agrotrace.core.problem.handler500"
