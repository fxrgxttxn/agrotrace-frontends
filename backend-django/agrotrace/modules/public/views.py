"""/public/batches/{publicCode}, /public/batches/{publicCode}/complaints, /public/captcha (contracts/openapi/paths/
public.yaml): no authentication (`security: []`, x-roles PUBLIC). downloadPublicFile and listPublicRegions live with
files and dictionaries. createPublicComplaint's `complaint-ip` limit is counted by ContractView.initial, first."""

from __future__ import annotations

from django.http import HttpResponse
from rest_framework.response import Response

from agrotrace.core.middleware import client_ip
from agrotrace.core.views import ContractView
from agrotrace.modules.public import services


class PublicBatchView(ContractView):
    operation_id = "getPublicBatch"

    def get(self, request, publicCode):  # noqa: N803
        # The stored (or just built) bytes as they are — never parsed or re-serialized (R82).
        return HttpResponse(services.page_bytes(publicCode), content_type="application/json; charset=utf-8")


class PublicComplaintsView(ContractView):
    operation_id = "createPublicComplaint"

    def post(self, request, publicCode):  # noqa: N803
        body = getattr(request, "json_body", {})
        return Response(services.complain(client_ip(request), publicCode, body), status=201)


class CaptchaView(ContractView):
    operation_id = "getCaptchaChallenge"

    def get(self, request):
        return Response(services.captcha(), headers={"Cache-Control": "no-store"})
