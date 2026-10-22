"""
The outbox sweeper (R55, R56, R59; contracts/events/envelope.schema.json), a job of beat-django every 5 s (plan 3: the
contract does not fix the process; Express runs it in its api). One pass, in ONE transaction on the job's connection:

1. only while `pg_try_advisory_xact_lock(hashtext('agrotrace.outbox.django'))` succeeds (another sweeper of this
   backend skips the pass);
2. retention (R59): this backend's `outbox_events` published more than 7 days ago and its `processed_events` older
   than 30 days are deleted;
3. the oldest 100 unpublished rows of this backend whose type has a handler (Ruling Q12), `ORDER BY created_at FOR
   NO KEY UPDATE SKIP LOCKED` — a row the relay thread holds in flight is skipped — are published and marked one by one
   (infra.relay.sweep_rows); a failed publish ends the pass, the marks before it commit.
"""

from __future__ import annotations

from agrotrace.core.tx import Tx, with_tx
from agrotrace.infra import relay
from agrotrace.scheduler.jobs import Job, register

NAME = "outbox-sweeper"
PERIOD_MS = 5000
BATCH = 100
LOCK_KEY = "agrotrace.outbox.django"


def _pass(tx: Tx) -> int:
    if not tx.scalar("SELECT pg_try_advisory_xact_lock(hashtext(%s))", [LOCK_KEY]):
        return 0
    tx.execute("DELETE FROM outbox_events WHERE backend = 'django' AND published_at < now() - interval '7 days'")
    tx.execute("DELETE FROM processed_events WHERE backend = 'django' AND processed_at < now() - interval '30 days'")
    published, _failed = relay.sweep_rows(tx, BATCH)
    return published


def run() -> int:
    """One sweeper pass; the number of rows published."""
    return with_tx(_pass, retry_once=False)


JOB = register(Job(NAME, run, period_ms=PERIOD_MS))
