"""GET /reports/{type} (contracts/openapi/paths/reports.yaml): the file goes out as an attachment named by the
contract (ASCII only, so `filename` and `filename*` carry the same name), `Content-Length`, `Cache-Control: no-store`.
A client that went away while its report waited gets nothing (its place in the queue is given up)."""

from __future__ import annotations

from django.http import HttpResponse

from agrotrace.core.views import ContractView
from agrotrace.modules.reports import render, service


class ReportView(ContractView):
    operation_id = "downloadReport"

    def get(self, request, type):  # noqa: A002 - the contract's path parameter
        try:
            f = service.download(self.principal, type, request)  # type: ignore[arg-type]
        except render.ReportAborted:
            return HttpResponse(status=204)  # nobody reads it: the connection is gone
        res = HttpResponse(f.body, status=200, content_type=f.content_type)
        res["Content-Length"] = str(len(f.body))
        res["Content-Disposition"] = f"attachment; filename=\"{f.file_name}\"; filename*=UTF-8''{f.file_name}"
        res["Cache-Control"] = "no-store"
        return res
