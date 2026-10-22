"""Business rules of @agrotrace/domain (packages/domain/src/rules.ts) used by the batches module: the BR-03 risk model
and the public batch code; the state machine is re-exported from domain.state_machine. Later tasks add their rules
(BR-01/02/04/05/07/08/09/10) here. Vectors: contracts/rules/vectors (tests/test_domain_vectors.py)."""

from __future__ import annotations

import hashlib
from typing import Literal

from agrotrace.domain.state_machine import available_actions, can_transition

__all__ = ["available_actions", "batch_code", "can_transition", "risk_model", "sample_bucket"]

RiskReason = Literal["NEW_FARM", "LOW_RATING", "RECENT_PESTICIDE", "SAMPLED", "NONE"]


def sample_bucket(public_code: str) -> int:
    """sha256(utf-8 publicCode) → the first 4 bytes as a big-endian uint32, mod 100."""
    return int.from_bytes(hashlib.sha256(public_code.encode("utf-8")).digest()[:4], "big") % 100


def risk_model(*, public_code: str, farm_batch_count: int, trust_rating: float,
               pesticide_treatments_last_30_days: int) -> tuple[bool, RiskReason]:
    """BR-03 `requiresLabTest`, checked in order: NEW_FARM (< 5 batches), LOW_RATING (< 70), RECENT_PESTICIDE (> 0),
    SAMPLED (the deterministic 20 % sample by the code's hash), else NONE."""
    if farm_batch_count < 5:
        return True, "NEW_FARM"
    if trust_rating < 70:
        return True, "LOW_RATING"
    if pesticide_treatments_last_30_days > 0:
        return True, "RECENT_PESTICIDE"
    if sample_bucket(public_code) < 20:
        return True, "SAMPLED"
    return False, "NONE"


def batch_code(year: int, n: int) -> str:
    """`formatBatchCode`: AT-{year}-{seq}, seq zero-padded to at least 6 digits (never truncated)."""
    return f"AT-{year}-{n:06d}"
