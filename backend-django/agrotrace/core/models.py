"""
Tables of the shared infrastructure as `managed = False` models over db/schema.sql (dbmate owns the schema). Writes
go through raw SQL (core.audit, infra.outbox: database defaults such as `created_at DEFAULT now()` must apply);
the models serve reads and test_models_schema.py, which checks every field against information_schema.
"""

from django.db import models


class AuditLog(models.Model):
    id = models.BigAutoField(primary_key=True)
    actor_id = models.UUIDField(null=True)
    action = models.CharField(max_length=64)
    entity_type = models.CharField(max_length=64)
    entity_id = models.UUIDField(null=True)
    diff = models.JSONField()
    ip = models.GenericIPAddressField(null=True)
    backend = models.CharField(max_length=8)
    request_id = models.CharField(max_length=64, null=True)
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = "audit_log"


class OutboxEvent(models.Model):
    id = models.UUIDField(primary_key=True)
    backend = models.CharField(max_length=8)
    type = models.CharField(max_length=64)
    payload = models.JSONField()
    created_at = models.DateTimeField()
    published_at = models.DateTimeField(null=True)
    attempts = models.IntegerField()

    class Meta:
        managed = False
        db_table = "outbox_events"


class ProcessedEvent(models.Model):
    event_id = models.UUIDField(primary_key=True)
    backend = models.CharField(max_length=8)
    processed_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = "processed_events"
