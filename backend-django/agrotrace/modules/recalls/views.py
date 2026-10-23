"""/recalls/* and /recall-tasks/* (contracts/openapi/paths/recalls.yaml, recall-tasks.yaml). Order of checks:
authentication and x-roles → `Idempotency-Key` (confirmRecallTask, x-idempotent, ContractView.initial) → the path id
first and alone (400 `validation.uuid`) → the query, or If-Match and the body in one 400 (P36) → the service (locks,
404, version, transitions)."""

from __future__ import annotations

from rest_framework.response import Response

from agrotrace.core.views import ContractView
from agrotrace.modules.recalls import services


class RecallsView(ContractView):
    operation_ids = {"GET": "listRecalls", "POST": "createRecall"}

    def get(self, request):
        return Response(services.list_recalls(request))

    def post(self, request):
        status, body = services.create_recall(self.principal, getattr(request, "json_body", {}))  # type: ignore[arg-type]
        return Response(body, status=status)


class RecallView(ContractView):
    operation_id = "getRecall"

    def get(self, request, id):
        return Response(services.get_recall(self.path_uuid()))


class RecallGraphView(ContractView):
    operation_id = "getRecallGraph"

    def get(self, request, id):
        return Response(services.recall_graph(self.path_uuid()))


class RecallTasksView(ContractView):
    operation_id = "listRecallTasks"

    def get(self, request):
        return Response(services.list_tasks(self.principal, request))  # type: ignore[arg-type]


class RecallTaskConfirmView(ContractView):
    operation_id = "confirmRecallTask"

    def post(self, request, id):
        task_id = self.path_uuid()
        version, errors = self.if_match_errors()
        body = getattr(request, "json_body", None)
        return Response(services.confirm_task(self.principal, task_id, version, errors, body))  # type: ignore[arg-type]
