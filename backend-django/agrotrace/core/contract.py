"""
The bundled contract (contracts/openapi.yaml → contracts/dist/openapi.json, built in the image): Swagger UI serves it
byte for byte, the method guard reads its path templates (405 + the contract's `Allow`, P3), and ContractView reads
`x-roles`, `x-org-admin`, `x-rate-limit` and `x-idempotent` of its operation from it (routes cannot drift from it).
CONTRACT_PATH overrides the location.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from agrotrace.core.config import ROOT

PREFIX = "/api/v1"
_METHODS = ("get", "put", "post", "delete", "patch", "head", "options", "trace")


@dataclass(frozen=True)
class Contract:
    doc: dict[str, Any]
    raw: bytes


@cache
def load() -> Contract:
    path = Path(os.environ.get("CONTRACT_PATH") or ROOT / "contracts" / "dist" / "openapi.json")
    raw = path.read_bytes()
    return Contract(doc=json.loads(raw), raw=raw)


def _segment(s: str) -> str:
    return "[^/]+" if re.fullmatch(r"\{[^/}]+\}", s) else re.escape(s)


@cache
def _routes() -> list[tuple[re.Pattern[str], tuple[str, ...]]]:
    out = []
    for template, item in load().doc["paths"].items():
        rx = re.compile("^" + re.escape(PREFIX) + "/".join(_segment(s) for s in template.split("/")) + r"\Z")
        out.append((rx, tuple(m.upper() for m in item if m in _METHODS)))
    return out


def contract_methods(path: str) -> list[str]:
    """Request path → the methods the contract declares for it (upper case, contract order); [] = no such path."""
    out: list[str] = []
    for rx, methods in _routes():
        if rx.match(path):
            out.extend(m for m in methods if m not in out)
    return out


@cache
def operation(operation_id: str) -> dict[str, Any]:
    """The operation object with `operation_id` (x-roles, …); KeyError if the contract lacks it."""
    for item in load().doc["paths"].values():
        for method, op in item.items():
            if method in _METHODS and op.get("operationId") == operation_id:
                return op
    raise KeyError(f"the contract has no operation {operation_id}")


def schema(name: str) -> dict[str, Any]:
    """`components.schemas.<name>` of the bundle."""
    return load().doc["components"]["schemas"][name]
