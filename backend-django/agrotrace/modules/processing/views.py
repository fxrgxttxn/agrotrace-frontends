"""/processing (contracts/openapi/paths/processing.yaml). Order of checks: authentication and x-roles (PROCESSOR) →
the body (400) → the service (locks, references, per-input rules, balance)."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.views import ContractView
from agrotrace.modules.processing import services


class ProcessingView(ContractView):
    operation_id = "processBatches"

    def post(self, request):
        body = getattr(request, "json_body", {})
        return Response(services.process(self.principal, body), status=201)  # type: ignore[arg-type]
