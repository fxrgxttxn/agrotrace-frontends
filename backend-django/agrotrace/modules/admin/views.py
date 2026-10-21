"""/admin/organizations/* (contracts/openapi/paths/admin.yaml): approve and update (listAdminOrganizations — Task 4)."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.problem import AppProblem
from agrotrace.core.views import ContractView, is_uuid
from agrotrace.modules.admin import services
from agrotrace.modules.admin.serializers import OrganizationAdminPatch


class AdminOrganizationView(ContractView):
    operation_ids = {"PATCH": "updateAdminOrganization"}

    def patch(self, request, id):
        org_id = self.path_uuid()
        assert self.principal is not None
        return Response(services.update(self.principal, org_id, self.body(OrganizationAdminPatch)))


class ApproveOrganizationView(ContractView):
    operation_id = "approveOrganization"

    def post(self, request, id):
        # The operation declares no 400: a malformed id names no organization → 404 (decision 1 of Express T4-5).
        if not is_uuid(id):
            raise AppProblem(404, "NOT_FOUND")
        assert self.principal is not None
        return Response(services.approve(self.principal, id.lower()))
