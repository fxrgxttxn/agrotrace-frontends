"""/organizations/* (contracts/openapi/paths/organizations.yaml): HTTP mapping of modules.organizations.services.
Upload order: 400 id → 400/413 form → 404/403 → 415 (P14)."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.multipart import read_single_file
from agrotrace.core.params import variant_param
from agrotrace.core.views import ContractView
from agrotrace.modules.files.services import CACHE_PRIVATE, serve
from agrotrace.modules.organizations import services


class OrganizationsView(ContractView):
    operation_id = "listOrganizations"

    def get(self, request):
        return Response(services.directory(request))


class OrganizationView(ContractView):
    operation_id = "getOrganization"

    def get(self, request, id):
        return Response(services.get(self.principal, self.path_uuid()))  # type: ignore[arg-type]


class OrganizationLogoView(ContractView):
    operation_ids = {"PUT": "uploadOrganizationLogo", "GET": "getOrganizationLogo"}

    def put(self, request, id):
        org_id = self.path_uuid()
        upload = read_single_file(request, max_bytes=services.LOGO_MAX_BYTES)
        return Response(services.upload_logo(self.principal, org_id, upload))  # type: ignore[arg-type]

    def get(self, request, id):
        org_id = self.path_uuid()
        variant = variant_param(request)
        f = services.logo_file(self.principal, org_id)  # type: ignore[arg-type]
        return serve(request, f, variant, CACHE_PRIVATE)
