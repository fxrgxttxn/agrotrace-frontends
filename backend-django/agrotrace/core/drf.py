"""
DRF pieces that keep its defaults away from the client: one renderer (compact JSON, UTF-8 without `\\u` escapes,
`application/json; charset=utf-8`) and a negotiation that always picks it (no 406; `?format=` is the contract's own
query parameter: URL_FORMAT_OVERRIDE = None). Request bodies are never parsed by DRF (core.body keeps the raw bytes).
"""

from __future__ import annotations

from rest_framework.negotiation import BaseContentNegotiation
from rest_framework.renderers import BaseRenderer

from agrotrace.core.render import json_bytes


class JsonRenderer(BaseRenderer):
    media_type = "application/json"
    format = "json"
    charset = "utf-8"

    def render(self, data, accepted_media_type=None, renderer_context=None) -> bytes:
        if data is None:
            return b""
        return json_bytes(data)


class AlwaysJson(BaseContentNegotiation):
    def select_parser(self, request, parsers):
        return parsers[0] if parsers else None

    def select_renderer(self, request, renderers, format_suffix=None):
        return renderers[0], renderers[0].media_type
