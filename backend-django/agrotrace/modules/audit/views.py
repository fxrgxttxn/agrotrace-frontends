"""/audit-log (contracts/openapi/paths/audit.yaml): the audit journal, read-only for ADMIN and INSPECTOR."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.views import ContractView
from agrotrace.modules.audit import services


class AuditLogView(ContractView):
    operation_id = "listAuditLog"

    def get(self, request):
        return Response(services.list_audit_log(request))
