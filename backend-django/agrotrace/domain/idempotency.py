"""Idempotency-Key handling (BR-11), the port of packages/domain/src/idempotency.ts."""

from __future__ import annotations

from typing import Literal

from agrotrace.core.patterns import ecma

# JS `$` anchors at the very end: a key with a trailing "\n" fails (core.patterns translates `$` to `\Z`).
_KEY = ecma(r"^[A-Za-z0-9_-]{8,128}$")

Decision = Literal["INVALID_KEY", "EXECUTE", "REPLAY", "CONFLICT"]


def idempotency_decision(key: str, stored: dict | None, fingerprint: str) -> Decision:
    if not _KEY.search(key):
        return "INVALID_KEY"
    if not stored:
        return "EXECUTE"
    return "REPLAY" if stored.get("fingerprint") == fingerprint else "CONFLICT"
