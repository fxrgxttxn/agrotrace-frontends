"""/fields/*, /treatments/{id} (contracts/openapi/paths/fields.yaml, treatments.yaml): HTTP mapping of
modules.fields.services — the path id first and alone (400 `validation.uuid`), then the query or the body."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.views import ContractView
from agrotrace.modules.fields import services


class FieldsView(ContractView):
    operation_ids = {"GET": "listFields", "POST": "createField"}

    def get(self, request):
        return Response(services.list_fields(self.principal, request))  # type: ignore[arg-type]

    def post(self, request):
        return Response(services.create_field(self.principal, getattr(request, "json_body", {})),  # type: ignore[arg-type]
                        status=201)


class FieldView(ContractView):
    operation_ids = {"GET": "getField", "PUT": "updateField", "DELETE": "deleteField"}

    def get(self, request, id):
        return Response(services.get_field(self.principal, self.path_uuid()))  # type: ignore[arg-type]

    def put(self, request, id):
        field_id = self.path_uuid()
        return Response(services.update_field(self.principal, field_id, getattr(request, "json_body", {})))  # type: ignore[arg-type]

    def delete(self, request, id):
        services.delete_field(self.principal, self.path_uuid())  # type: ignore[arg-type]
        return Response(status=204)


class FieldTreatmentsView(ContractView):
    operation_ids = {"GET": "listFieldTreatments", "POST": "createTreatment"}

    def get(self, request, id):
        field_id = self.path_uuid()
        return Response(services.list_treatments(self.principal, field_id, request))  # type: ignore[arg-type]

    def post(self, request, id):
        field_id = self.path_uuid()
        return Response(services.create_treatment(self.principal, field_id, getattr(request, "json_body", {})),  # type: ignore[arg-type]
                        status=201)


class TreatmentView(ContractView):
    operation_id = "updateTreatment"

    def put(self, request, id):
        treatment_id = self.path_uuid()
        return Response(services.update_treatment(self.principal, treatment_id, getattr(request, "json_body", {})))  # type: ignore[arg-type]
