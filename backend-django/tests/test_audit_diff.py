"""core.audit diffs (decisions 3–5 of Express Tasks 4–5): secrets are "***" on both sides; an unchanged update writes
no row; a hard delete is `[before, null]` per non-null field. The dictionary update runs inside a rolled-back
transaction (audit_log is append-only for agrotrace_app)."""

import uuid

import pytest
from django.db import transaction

from agrotrace.core import audit, sql
from agrotrace.core.tx import Tx
from agrotrace.modules.dictionaries import services
from agrotrace.security.jwt import Principal

ADMIN = Principal(user_id=str(uuid.uuid4()), org_id=str(uuid.uuid4()), roles=("ADMIN",), org_admin=False)


def test_a_creation_lists_every_filled_field_and_secrets_stay_masked():
    diff = audit.audit_diff(None, {"email": "a@b.ru", "password": audit.SECRET, "phone": None})
    assert diff == {"email": [None, "a@b.ru"], "password": [None, "***"]}
    assert audit.audit_diff({"password": audit.SECRET}, {"password": audit.SECRET}) == {}


def test_only_changed_fields_and_json_equality():
    before = {"name": "a", "geometry": {"type": "Polygon", "coordinates": [[[1, 2]]]}, "n": 1}
    after = {"name": "b", "geometry": {"type": "Polygon", "coordinates": [[[1, 2]]]}, "n": 1.0}
    assert audit.audit_diff(before, after) == {"name": ["a", "b"]}


def test_a_hard_delete_mirrors_a_creation():
    assert audit.audit_removal({"code": "77", "name": "Москва", "x": None}) == {"code": ["77", None],
                                                                                 "name": ["Москва", None]}


@pytest.fixture
def rolled_back(db, monkeypatch):
    """Runs the service's transactions inside one outer transaction that is rolled back."""
    monkeypatch.setattr(services, "with_tx", lambda fn, **kw: fn(Tx()))
    with transaction.atomic():
        yield
        transaction.set_rollback(True)


def _audit_rows(entity_id: str) -> int:
    return sql.scalar("SELECT count(*) FROM audit_log WHERE entity_id = %s", [entity_id])


def test_an_unchanged_update_writes_no_row_and_no_audit_entry(rolled_back):
    code = "T" + uuid.uuid4().hex[:6].upper()
    created = services.create(ADMIN, "regions", {"code": code, "name": "Тестовая область"})
    assert _audit_rows(created["id"]) == 1
    same = services.update(ADMIN, "regions", created["id"], {"code": code, "name": "Тестовая область"})
    assert same == created and _audit_rows(created["id"]) == 1
    services.update(ADMIN, "regions", created["id"], {"code": code, "name": "Другая"})
    assert _audit_rows(created["id"]) == 2
    diff = sql.jsonb(sql.scalar("SELECT diff FROM audit_log WHERE entity_id = %s AND action = 'updateDictionaryEntry'",
                                [created["id"]]))
    assert diff == {"name": ["Тестовая область", "Другая"]}


def test_decimals_compare_numerically(rolled_back):
    name = f"Тест {uuid.uuid4().hex[:8]}"
    p = services.create(ADMIN, "products", {"name": name, "category": "GRAIN", "lossNormPercent": "2.50"})
    services.update(ADMIN, "products", p["id"], {"name": name, "category": "GRAIN", "lossNormPercent": "2.50"})
    assert _audit_rows(p["id"]) == 1
    services.remove(ADMIN, "products", p["id"])
    diff = sql.jsonb(sql.scalar("SELECT diff FROM audit_log WHERE entity_id = %s AND action = 'deleteDictionaryEntry'",
                                [p["id"]]))
    assert list(diff) == ["deletedAt"] and diff["deletedAt"][0] is None
