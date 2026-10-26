"""GET /analytics/dashboard (contracts/openapi/paths/analytics.yaml): authentication and x-roles (ContractView) →
scope and window in one 400 → the snapshot."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.views import ContractView
from agrotrace.modules.analytics import dashboard


class DashboardView(ContractView):
    operation_id = "getDashboard"

    def get(self, request):
        return Response(dashboard.get_dashboard(self.principal, request))  # type: ignore[arg-type]
