"""
The consumer's first statement (R56, contracts/events/envelope.schema.json), the port of
backend-express/src/events/claim.ts: `INSERT INTO processed_events … ON CONFLICT DO NOTHING` inside the handler's
transaction. False — the event was already handled (a redelivery, or a parallel consumer committed it first): the
handler writes nothing.
"""

from __future__ import annotations

from agrotrace.core import sql
from agrotrace.core.tx import Tx


def claim(tx: Tx, event_id: str) -> bool:
    return tx.scalar(
        "INSERT INTO processed_events (event_id, backend) VALUES (%s, 'django') ON CONFLICT (event_id) DO NOTHING "
        "RETURNING true", [event_id]) is True


def already_claimed(event_id: str) -> bool:
    """A read outside any transaction (the handler's early exit; the claim in its transaction decides)."""
    return sql.scalar("SELECT EXISTS (SELECT 1 FROM processed_events WHERE event_id = %s)", [event_id]) is True
