"""
Generated schema vs the contract (spec §8.3 / §14.1 «сравнение сгенерированных схем»): the OpenAPI document
drf-spectacular generates in memory from the routes (SpectacularAPIView, the view the spec names) declares exactly the
`(path, method, operationId)` set of the bundled contract — no route missing, none extra, none bound to the wrong
operation. The full schemas are not compared: the bundle Swagger UI serves (`/docs`) stays the source of truth, the
views carry no serializers to describe it a second time.

drf-spectacular sees DRF views only. The routes of plain Django views are walked from the URL resolver: the SSE stream
(an async view on the event loop, sse/stream.py) is the one contract operation among them; the rest is Swagger UI
(`/docs` assets, not operations of the contract).
"""

from __future__ import annotations

import json

from django.conf import settings
from django.test import RequestFactory, override_settings
from django.urls import URLPattern, URLResolver, get_resolver
from drf_spectacular.openapi import AutoSchema
from drf_spectacular.renderers import OpenApiJsonRenderer
from drf_spectacular.views import SpectacularAPIView

from agrotrace.core import contract
from agrotrace.sse.stream import stream_events

METHODS = ("get", "put", "post", "delete", "patch", "head", "options", "trace")
#: Plain (non-DRF) views bound to a contract operation: callback → (method, operationId).
PLAIN_OPERATIONS = {stream_events: ("get", "streamEvents")}
#: Modules of plain views that serve no contract operation.
NON_CONTRACT_MODULES = ("agrotrace.modules.docs.",)


class ContractSchema(AutoSchema):
    """operationId = the contract operation the view binds (ContractView.operation_ids / operation_id)."""

    def get_operation_id(self):
        view = self.view
        ids = getattr(view, "operation_ids", None) or {}
        return ids.get(self.method.upper()) or getattr(view, "operation_id", "") or super().get_operation_id()


def _generated() -> set[tuple[str, str, str]]:
    rest = {**settings.REST_FRAMEWORK, "DEFAULT_SCHEMA_CLASS": "tests.test_schema_parity.ContractSchema"}
    spectacular = {"SCHEMA_PATH_PREFIX": "/api/v1", "DISABLE_ERRORS_AND_WARNINGS": True}
    with override_settings(REST_FRAMEWORK=rest, SPECTACULAR_SETTINGS=spectacular):
        view = SpectacularAPIView.as_view(renderer_classes=[OpenApiJsonRenderer], authentication_classes=[],
                                          permission_classes=[])
        res = view(RequestFactory().get("/schema", HTTP_ACCEPT="application/vnd.oai.openapi+json"))
        res.render()
    assert res.status_code == 200, res.content[:500]
    doc = json.loads(res.content)
    out = set()
    for path, item in doc["paths"].items():
        assert path.startswith(contract.PREFIX + "/"), path
        for method, op in item.items():
            if method in METHODS:
                out.add((path[len(contract.PREFIX):], method, op["operationId"]))
    return out


def _walk(patterns, prefix: str = ""):
    for p in patterns:
        if isinstance(p, URLResolver):
            yield from _walk(p.url_patterns, prefix + str(p.pattern))
        elif isinstance(p, URLPattern):
            yield prefix + str(p.pattern), p.callback


def _plain() -> set[tuple[str, str, str]]:
    """Contract operations of the plain Django views; every other plain view is Swagger UI."""
    out = set()
    for route, callback in _walk(get_resolver().url_patterns):
        if getattr(callback, "cls", None) is not None:  # a DRF view: drf-spectacular's part
            continue
        if callback in PLAIN_OPERATIONS:
            method, op_id = PLAIN_OPERATIONS[callback]
            template = "/" + route.removeprefix(contract.PREFIX.lstrip("/") + "/")
            template = template.replace("<str:", "{").replace(">", "}")
            out.add((template, method, op_id))
        else:
            assert callback.__module__.startswith(NON_CONTRACT_MODULES), (route, callback)
    return out


def _bundle() -> set[tuple[str, str, str]]:
    return {(path, method, op["operationId"])
            for path, item in contract.load().doc["paths"].items()
            for method, op in item.items() if method in METHODS}


def test_generated_operations_equal_the_contract_bundle():
    generated, bundle = _generated() | _plain(), _bundle()
    assert len(bundle) == 92
    missing, extra = sorted(bundle - generated), sorted(generated - bundle)
    assert not missing and not extra, f"missing from the routes: {missing}\nnot in the contract: {extra}"
