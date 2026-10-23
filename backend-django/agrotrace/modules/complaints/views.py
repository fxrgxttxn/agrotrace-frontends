"""/complaints/* (contracts/openapi/paths/complaints.yaml), INSPECTOR only. Order of checks: authentication and x-roles
→ the path id first and alone (400 `validation.uuid`) → the query or the body (400) → the service (lock, 404,
transition, references)."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.views import ContractView
from agrotrace.modules.complaints import services


class ComplaintsView(ContractView):
    operation_id = "listComplaints"

    def get(self, request):
        return Response(services.list_complaints(request))


class ComplaintView(ContractView):
    operation_id = "getComplaint"

    def get(self, request, id):
        return Response(services.get_complaint(self.path_uuid()))


class ComplaintReviewView(ContractView):
    operation_id = "startComplaintReview"

    def post(self, request, id):
        complaint_id = self.path_uuid()
        body = getattr(request, "json_body", None)
        return Response(services.review(self.principal, complaint_id, body))  # type: ignore[arg-type]


class ComplaintDecisionView(ContractView):
    operation_id = "decideComplaint"

    def post(self, request, id):
        complaint_id = self.path_uuid()
        body = getattr(request, "json_body", {})
        return Response(services.decide(self.principal, complaint_id, body))  # type: ignore[arg-type]
