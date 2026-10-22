"""/waybills/* (contracts/openapi/paths/waybills.yaml). Order of checks: authentication and x-roles → `Idempotency-Key`
(x-idempotent, ContractView.initial) → the path id first and alone (400 `validation.uuid`) → If-Match and the body in
one 400 (P36) → the service (locks, 404, side, version, transition, references, per-item rules)."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.views import ContractView
from agrotrace.modules.waybills import services


class WaybillsView(ContractView):
    operation_ids = {"GET": "listWaybills", "POST": "createWaybill"}

    def get(self, request):
        return Response(services.list_waybills(self.principal, request))  # type: ignore[arg-type]

    def post(self, request):
        body = getattr(request, "json_body", {})
        return Response(services.create_waybill(self.principal, body), status=201)  # type: ignore[arg-type]


class WaybillView(ContractView):
    operation_ids = {"GET": "getWaybill", "DELETE": "deleteWaybill"}

    def get(self, request, id):
        return Response(services.get_waybill(self.principal, self.path_uuid()))  # type: ignore[arg-type]

    def delete(self, request, id):
        waybill_id = self.path_uuid()
        services.delete_waybill(self.principal, waybill_id, self.if_match())  # type: ignore[arg-type]
        return Response(status=204)


class WaybillSendView(ContractView):
    operation_id = "sendWaybill"

    def post(self, request, id):
        waybill_id = self.path_uuid()
        return Response(services.send_waybill(self.principal, waybill_id, self.if_match()))  # type: ignore[arg-type]


class WaybillAcceptView(ContractView):
    operation_id = "acceptWaybill"

    def post(self, request, id):
        waybill_id = self.path_uuid()
        version, errors = self.if_match_errors()
        body = getattr(request, "json_body", {})
        return Response(services.accept_waybill(self.principal, waybill_id, version, errors, body))  # type: ignore[arg-type]


class WaybillRejectView(ContractView):
    operation_id = "rejectWaybill"

    def post(self, request, id):
        waybill_id = self.path_uuid()
        version, errors = self.if_match_errors()
        body = getattr(request, "json_body", {})
        return Response(services.reject_waybill(self.principal, waybill_id, version, errors, body))  # type: ignore[arg-type]
