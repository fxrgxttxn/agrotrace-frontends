"""/dictionaries/* and GET /public/regions (contracts/openapi/paths/dictionaries.yaml, public.yaml): HTTP mapping of
modules.dictionaries.services. The name is checked first and alone (400 `errors.name: [validation.enum]`), then the id
(400 `validation.uuid`), then the body or the form (400/413) — the order of backend-express routes.ts."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.multipart import read_single_file
from agrotrace.core.views import ContractView
from agrotrace.modules.dictionaries import services, store


class DictionaryView(ContractView):
    operation_ids = {"GET": "listDictionary", "POST": "createDictionaryEntry"}

    def get(self, request, name):
        name = store.dict_name(name)
        return Response(services.list_entries(self.principal, name, request))  # type: ignore[arg-type]

    def post(self, request, name):
        name = store.dict_name(name)
        return Response(services.create(self.principal, name, getattr(request, "json_body", {})),  # type: ignore[arg-type]
                        status=201)


class DictionaryEntryView(ContractView):
    """`/dictionaries/{name}/{id}` (PUT, DELETE) — and `/dictionaries/{name}/import` (POST), the same two segments."""

    operation_ids = {"PUT": "updateDictionaryEntry", "DELETE": "deleteDictionaryEntry", "POST": "importDictionary"}

    def put(self, request, name, id):
        name = store.dict_name(name)
        row_id = self.path_uuid()
        return Response(services.update(self.principal, name, row_id, getattr(request, "json_body", {})))  # type: ignore[arg-type]

    def delete(self, request, name, id):
        name = store.dict_name(name)
        row_id = self.path_uuid()
        services.remove(self.principal, name, row_id)  # type: ignore[arg-type]
        return Response(status=204)

    def post(self, request, name, id):
        # Only `/dictionaries/{name}/import` reaches here: the method guard answers 405 for POST on any other id.
        name = store.dict_name(name)
        upload = read_single_file(request, max_bytes=services.IMPORT_MAX_BYTES)
        return Response(services.import_dictionary(self.principal, name, upload.data))  # type: ignore[arg-type]


class ProductImageView(ContractView):
    operation_id = "uploadProductImage"

    def put(self, request, id):
        product_id = self.path_uuid()
        upload = read_single_file(request, max_bytes=services.PRODUCT_IMAGE_MAX_BYTES)
        return Response(services.upload_image(self.principal, product_id, upload))  # type: ignore[arg-type]


class PublicRegionsView(ContractView):
    operation_id = "listPublicRegions"

    def get(self, request):
        return Response(services.public_regions())
