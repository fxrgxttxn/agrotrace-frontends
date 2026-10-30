"""/notifications and /notifications/read (contracts/openapi/paths/notifications.yaml), x-roles ANY. The SSE stream
GET /events/stream is the async view of sse/stream.py."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.views import ContractView
from agrotrace.modules.notifications import services


class NotificationsView(ContractView):
    operation_id = "listNotifications"

    def get(self, request):
        return Response(services.list_notifications(self.principal, request))  # type: ignore[arg-type]


class NotificationsReadView(ContractView):
    operation_id = "markNotificationsRead"

    def post(self, request):
        return Response(services.mark_read(self.principal, getattr(request, "json_body", {})))  # type: ignore[arg-type]
