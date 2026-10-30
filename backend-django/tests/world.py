"""A small graph world on agrotrace_test_django for the recall, rating and scheduler DB tests: organizations, a
product, batches (any status, soft-deleted or not), links, users. Everything it creates — and every row the code under
test writes about those batches and organizations — is removed by `cleanup()`."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

from agrotrace.core import sql


class World:
    def __init__(self) -> None:
        self.orgs: list[str] = []
        self.users: list[str] = []
        self.products: list[str] = []
        self.batches: list[str] = []
        self.labs_tests: list[str] = []
        self.since = sql.scalar("SELECT clock_timestamp()")

    def org(self, type_: str, name: str | None = None, *, rating: int | None = 80) -> str:
        oid = sql.scalar(
            "INSERT INTO organizations (type, name, inn, region_id, status, trust_rating) "
            "VALUES (%s, %s, %s, (SELECT id FROM regions ORDER BY code LIMIT 1), 'ACTIVE', %s) RETURNING id::text",
            [type_, name or f"{type_} {uuid.uuid4().hex[:6]}", str(uuid.uuid4().int)[:12],
             rating if type_ == "FARM" else None])
        self.orgs.append(oid)
        return oid

    def user(self, org: str, *, role: str | None = None, head: bool = False) -> str:
        uid = sql.scalar(
            "INSERT INTO users (organization_id, email, password_hash, full_name, is_org_admin, status, "
            "notification_channels) VALUES (%s, %s, 'x', 'T', %s, 'ACTIVE', %s::jsonb) RETURNING id::text",
            [org, f"w-{uuid.uuid4().hex[:10]}@agrotrace.test", head,
             json.dumps({"email": False, "telegram": False})])
        if role:
            sql.execute("INSERT INTO user_roles (user_id, role_id) SELECT %s, id FROM roles WHERE code = %s",
                        [uid, role])
        self.users.append(uid)
        return uid

    def product(self) -> str:
        if not self.products:
            self.products.append(sql.scalar(
                "INSERT INTO products (name, category, loss_norm_percent) VALUES (%s, 'GRAIN', 5.00) "
                "RETURNING id::text", [f"Продукт {uuid.uuid4().hex[:6]}"]))
        return self.products[0]

    def batch(self, origin: str, *, status: str = "Approved", holder: str | None = None, deleted: bool = False,
              kind: str = "RAW") -> str:
        code = f"ZZ-{uuid.uuid4().hex[:12].upper()}"
        at = datetime(2026, 9, 1, tzinfo=UTC)
        bid = sql.scalar(
            "INSERT INTO batches (public_code, product_id, origin_org_id, holder_org_id, kind, mass_kg, harvested_at, "
            "produced_at, status, deleted_at) VALUES (%s, %s, %s, %s, %s, 100.000, %s, %s, %s, "
            "CASE WHEN %s THEN now() END) RETURNING id::text",
            [code, self.product(), origin, holder or origin, kind, at if kind == "RAW" else None,
             at if kind == "DERIVED" else None, status, deleted])
        self.batches.append(bid)
        return bid

    def link(self, parent: str, child: str) -> None:
        sql.execute("INSERT INTO batch_links (parent_batch_id, child_batch_id, mass_used_kg) VALUES (%s, %s, 1.000)",
                    [parent, child])

    def recall(self, source: str, *, opened_at: datetime, deleted: bool = False, rid: str | None = None) -> str:
        """A CLOSED recall row (data state; the engine is tested elsewhere)."""
        return sql.scalar(
            "INSERT INTO recalls (id, source_batch_id, trigger, reason, status, opened_at, closed_at, version, deleted_at) "
            "VALUES (coalesce(%s::uuid, gen_random_uuid()), %s, 'INSPECTOR', 'r', 'CLOSED', %s, %s, 2, "
            "CASE WHEN %s THEN now() END) RETURNING id::text", [rid, source, opened_at, opened_at, deleted])

    def lab_test(self, batch: str, lab: str, *, tid: str | None = None, status: str = "QUEUED", conclusion: str | None = None,
                 completed_at: datetime | None = None, due_at: datetime | None = None,
                 deleted: bool = False) -> str:
        tid = sql.scalar(
            "INSERT INTO lab_tests (id, batch_id, lab_org_id, reason, status, conclusion, completed_at, sampled_at, "
            "due_at, deleted_at) VALUES (coalesce(%s::uuid, gen_random_uuid()), %s, %s, 'INSPECTOR', %s, %s, %s, %s, %s, CASE WHEN %s THEN now() END) "
            "RETURNING id::text",
            [tid, batch, lab, status, conclusion, completed_at, completed_at,
             due_at or datetime.now(UTC) + timedelta(days=5), deleted])
        self.labs_tests.append(tid)
        return tid

    def recall_ids(self) -> list[str]:
        return [r["id"] for r in sql.all("SELECT id::text AS id FROM recalls WHERE source_batch_id = ANY(%s::uuid[])",
                                         [self.batches])]

    def cleanup(self) -> None:
        recalls = self.recall_ids()
        tests = [r["id"] for r in sql.all("SELECT id::text AS id FROM lab_tests WHERE batch_id = ANY(%s::uuid[])",
                                          [self.batches])]
        # audit_log is append-only for the application role: its rows stay.
        sql.execute("DELETE FROM recall_tasks WHERE recall_id = ANY(%s::uuid[])", [recalls])
        sql.execute("DELETE FROM recall_batches WHERE recall_id = ANY(%s::uuid[])", [recalls])
        # recalls.lab_test_id ↔ lab_tests.recall_id: break the pair first.
        sql.execute("UPDATE recalls SET lab_test_id = NULL WHERE id = ANY(%s::uuid[])", [recalls])
        sql.execute("DELETE FROM lab_results WHERE lab_test_id = ANY(%s::uuid[])", [tests])
        sql.execute("DELETE FROM lab_tests WHERE id = ANY(%s::uuid[])", [tests])
        sql.execute("DELETE FROM recalls WHERE id = ANY(%s::uuid[])", [recalls])
        sql.execute("DELETE FROM batch_status_history WHERE batch_id = ANY(%s::uuid[])", [self.batches])
        sql.execute("DELETE FROM batch_links WHERE parent_batch_id = ANY(%s::uuid[]) "
                    "OR child_batch_id = ANY(%s::uuid[])", [self.batches, self.batches])
        sql.execute("DELETE FROM batches WHERE id = ANY(%s::uuid[])", [self.batches])
        sql.execute("DELETE FROM products WHERE id = ANY(%s::uuid[])", [self.products])
        sql.execute("DELETE FROM notifications WHERE user_id = ANY(%s::uuid[])", [self.users])
        sql.execute("DELETE FROM user_roles WHERE user_id = ANY(%s::uuid[])", [self.users])
        sql.execute("DELETE FROM users WHERE id = ANY(%s::uuid[])", [self.users])
        sql.execute("DELETE FROM organizations WHERE id = ANY(%s::uuid[])", [self.orgs])
        sql.execute("DELETE FROM outbox_events WHERE backend = 'django' AND created_at >= %s", [self.since])
        sql.execute("DELETE FROM processed_events WHERE backend = 'django' AND processed_at >= %s", [self.since])
