"""/lab-tests/* (contracts/openapi/paths/lab.yaml). Order of checks: authentication and x-roles → the path id first and
alone (400 `validation.uuid`) → the query, or If-Match and the body in one 400 (P36) → the service (lock, 404, version,
transition, per-operation steps); the protocol upload: the multipart reader (400, 413) right after the id."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.multipart import read_single_file
from agrotrace.core.views import ContractView
from agrotrace.modules.files.services import CACHE_PRIVATE, serve
from agrotrace.modules.lab import services


class LabTestsView(ContractView):
    operation_ids = {"GET": "listLabTests", "POST": "createLabTest"}

    def get(self, request):
        return Response(services.list_tests(self.principal, request))  # type: ignore[arg-type]

    def post(self, request):
        body = getattr(request, "json_body", {})
        return Response(services.create_test(self.principal, body), status=201)  # type: ignore[arg-type]


class LabTestView(ContractView):
    operation_id = "getLabTest"

    def get(self, request, id):
        return Response(services.get_test(self.principal, self.path_uuid()))  # type: ignore[arg-type]


class LabSampleView(ContractView):
    operation_id = "registerLabSample"

    def post(self, request, id):
        test_id = self.path_uuid()
        version, errors = self.if_match_errors()
        body = getattr(request, "json_body", {})
        return Response(services.register_sample(self.principal, test_id, version, errors, body))  # type: ignore[arg-type]


class LabResultsView(ContractView):
    operation_id = "submitLabResults"

    def post(self, request, id):
        test_id = self.path_uuid()
        version, errors = self.if_match_errors()
        body = getattr(request, "json_body", {})
        return Response(services.submit_results(self.principal, test_id, version, errors, body))  # type: ignore[arg-type]


class LabProtocolView(ContractView):
    operation_ids = {"PUT": "uploadLabProtocol", "GET": "downloadLabProtocol"}

    def put(self, request, id):
        test_id = self.path_uuid()
        upload = read_single_file(request, max_bytes=services.PROTOCOL_MAX_BYTES)
        return Response(services.upload_protocol(self.principal, test_id, upload))  # type: ignore[arg-type]

    def get(self, request, id):
        test_id = self.path_uuid()
        f = services.protocol_file(self.principal, test_id)  # type: ignore[arg-type]
        return serve(request, f, 480, CACHE_PRIVATE)
