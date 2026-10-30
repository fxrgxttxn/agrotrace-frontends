"""
The beat job `notification-delivery` (P49, contracts/events/notification.dispatch.schema.json), the port of
backend-express/src/scheduler/jobs/notification-delivery.ts, every SCHEDULER_TICK_MS (and once at start) under the
session advisory lock `agrotrace.scheduler.notification-delivery` (scheduler.runner): the PENDING EMAIL/TELEGRAM rows
whose sender died — `coalesce(claimed_at, created_at)` older than 5 minutes — are each claimed with a conditional
`UPDATE … SET claimed_at = now()` (no row lock is held while sending; a row another sender claimed in between is
skipped) and sent within the rest of their 3-attempt budget (modules/notifications/delivery.py, `mode='stale'`),
synchronously on the job's thread and connection (P61: beat has one connection per job and no send threads). Any
implementation's sweeper may take any such row: the claim makes a second sender skip it for 5 minutes.
"""

from __future__ import annotations

from agrotrace.modules.notifications import delivery
from agrotrace.scheduler.jobs import Job, register

NAME = "notification-delivery"


def run() -> int:
    return delivery.sweep()


JOB = register(Job(NAME, run))
