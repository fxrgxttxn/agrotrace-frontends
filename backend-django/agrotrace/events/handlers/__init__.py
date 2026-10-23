"""The event types that have a handler in worker-django, and the module that registers each (Ruling Q12): the relay
and the sweeper publish only these types; rows of any other type stay unpublished in the outbox until the task that
owns their handler adds it here (Tasks 9–12). celery_app imports exactly these modules in the worker.

Kept free of Celery/Django imports: the api process reads it to filter what it publishes."""

HANDLER_MODULES: dict[str, str] = {
    "vsd.import": "agrotrace.events.handlers.vsd_import",
    "lab.escalate": "agrotrace.events.handlers.lab_escalate",
    "recall.requested": "agrotrace.events.handlers.recall_requested",
    "rating.recalculate": "agrotrace.events.handlers.rating_recalculate",
}

#: Event types the outbox publishes (in contract enum order is irrelevant; a set of names).
HANDLED_TYPES: tuple[str, ...] = tuple(HANDLER_MODULES)
