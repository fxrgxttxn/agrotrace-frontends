"""/batches/* (contracts/openapi/paths/batches.yaml): HTTP mapping of the batches, QR and documents services — the
path id first and alone (400 `validation.uuid`), then the query, If-Match or the body."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.params import QueryReader
from agrotrace.core.problem import validation_problem
from agrotrace.core.views import ContractView
from agrotrace.modules.batches import qr, services
from agrotrace.modules.batches.serializers import QrRequest
from agrotrace.modules.documents import services as documents


class BatchesView(ContractView):
    operation_ids = {"GET": "listBatches", "POST": "createBatch"}

    def get(self, request):
        return Response(services.list_batches(self.principal, request))  # type: ignore[arg-type]

    def post(self, request):
        return Response(services.create_batch(self.principal, getattr(request, "json_body", {})),  # type: ignore[arg-type]
                        status=201)


class BatchView(ContractView):
    operation_id = "getBatch"

    def get(self, request, id):
        return Response(services.get_batch(self.principal, self.path_uuid()))  # type: ignore[arg-type]


class BatchGraphView(ContractView):
    operation_id = "getBatchGraph"

    def get(self, request, id):
        batch_id = self.path_uuid()
        return Response(services.graph(self.principal, batch_id, request))  # type: ignore[arg-type]


class BatchHistoryView(ContractView):
    operation_id = "getBatchHistory"

    def get(self, request, id):
        return Response(services.history(self.principal, self.path_uuid()))  # type: ignore[arg-type]


class BatchPathView(ContractView):
    operation_id = "getBatchPath"

    def get(self, request, id):
        return Response(services.path(self.principal, self.path_uuid()))  # type: ignore[arg-type]


class BatchQrView(ContractView):
    operation_ids = {"GET": "downloadBatchQr", "POST": "createBatchQr"}

    def post(self, request, id):
        batch_id = self.path_uuid()
        # requestBody optional: absent (the JSON middleware leaves `{}`) or exactly `{}`.
        self.body(QrRequest)
        return Response(qr.create(self.principal, batch_id), status=201)  # type: ignore[arg-type]

    def get(self, request, id):
        batch_id = self.path_uuid()
        q = QueryReader(request)
        fmt = q.enum_of("format", ("png", "pdf"))
        if not q.has("format"):
            raise validation_problem({**q.errors, "format": ["validation.required"]})
        q.done()
        return qr.download(request, self.principal, batch_id, fmt)  # type: ignore[arg-type]


class BatchDocumentsView(ContractView):
    operation_id = "getBatchDocuments"

    def get(self, request, id):
        return Response(documents.get_documents(self.principal, self.path_uuid()))  # type: ignore[arg-type]


class BatchVsdRetryView(ContractView):
    operation_id = "retryBatchVsdImport"

    def post(self, request, id):
        return Response(documents.retry_vsd(self.principal, self.path_uuid()), status=202)  # type: ignore[arg-type]


class BatchOnSaleView(ContractView):
    operation_id = "putBatchOnSale"

    def post(self, request, id):
        batch_id = self.path_uuid()
        return Response(services.put_on_sale(self.principal, batch_id, self.if_match()))  # type: ignore[arg-type]


class BatchSoldView(ContractView):
    operation_id = "markBatchSold"

    def post(self, request, id):
        batch_id = self.path_uuid()
        return Response(services.mark_sold(self.principal, batch_id, self.if_match()))  # type: ignore[arg-type]
