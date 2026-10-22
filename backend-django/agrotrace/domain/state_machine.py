"""The batch state machine (contracts/rules/state-machine.json), the port of packages/domain/src/state-machine.ts:
`can_transition` and `available_actions` (the transitions from a status, in file order)."""

from __future__ import annotations

import json
from functools import cache
from typing import Any

from agrotrace.core import config


@cache
def _machine() -> dict[str, Any]:
    return json.loads((config.ROOT / "contracts" / "rules" / "state-machine.json").read_text("utf-8"))


def batch_statuses() -> tuple[str, ...]:
    return tuple(_machine()["statuses"])


def can_transition(frm: str, to: str) -> bool:
    return any(t["from"] == frm and t["to"] == to for t in _machine()["transitions"])


def available_actions(frm: str) -> list[dict[str, str]]:
    """`[{action, to}]` of every transition from `frm`, in the file's order."""
    return [{"action": t["action"], "to": t["to"]} for t in _machine()["transitions"] if t["from"] == frm]
