"""
P61 holder discipline (review I1 of Tasks 2+3): a thread holds a pool connection only around its SQL. Outside a
transaction every core.sql statement gives the connection back; `with_tx` gives it back after the commit; `pinned()`
keeps one session (scheduler advisory locks). Argon2, Pillow, MinIO and Lane waits therefore run without a connection,
and a flood of heavy requests cannot starve unrelated ones (the 503s of the review's probe).
"""

import ast
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from django.db import connections

import agrotrace
from agrotrace.core import sql
from agrotrace.core.multipart import Upload
from agrotrace.core.tx import with_tx
from tests.test_images import png


@pytest.fixture(autouse=True)
def _clean(db):
    yield
    connections.close_all()


def test_statements_outside_a_transaction_release_the_connection():
    assert sql.scalar("SELECT 1") == 1
    assert not sql.holds_connection()
    sql.all("SELECT 1 AS a")
    sql.execute("SELECT 1")
    assert not sql.holds_connection()


def test_with_tx_holds_inside_and_releases_after():
    seen = []

    def run(tx):
        tx.scalar("SELECT 1")
        seen.append(sql.holds_connection())
        tx.scalar("SELECT 2")
        seen.append(sql.holds_connection())

    with_tx(run)
    assert seen == [True, True] and not sql.holds_connection()


def test_pinned_keeps_one_session():
    with sql.pinned():
        pid = sql.scalar("SELECT pg_backend_pid()")
        assert sql.holds_connection()
        assert sql.scalar("SELECT pg_backend_pid()") == pid
    sql.release()
    assert not sql.holds_connection()


def test_release_inside_a_transaction_is_an_error():
    def run(tx):
        sql.release()

    with pytest.raises(AssertionError):
        with_tx(run)


def test_image_decoding_and_storage_run_without_a_connection(monkeypatch):
    from agrotrace.modules.files import services as files

    holds = []
    monkeypatch.setattr("agrotrace.infra.images.variants",
                        lambda data, mime, cancelled=None: holds.append(("variants", sql.holds_connection())) or {"96": b"x", "480": b"y"})
    monkeypatch.setattr("agrotrace.infra.s3.put", lambda *a: holds.append(("put", sql.holds_connection())))
    monkeypatch.setattr("agrotrace.infra.s3.bucket", lambda: "test")
    p = files.prepare(Upload("a.png", png(4, 4)), kind="AVATAR", owner_id=None, allowed=("image/png",))
    files.store_objects(p)
    assert holds and all(not h for _, h in holds), holds


def test_serving_reads_storage_without_a_connection(monkeypatch):
    from agrotrace.modules.files import services as files

    holds = []
    monkeypatch.setattr("agrotrace.infra.s3.get", lambda key: holds.append(sql.holds_connection()) or b"data")
    sql.scalar("SELECT 1")
    f = {"variants": "{}", "object_key": "k", "sha256": "0" * 64, "mime": "application/pdf", "original_name": "a.pdf"}
    res = files.serve(SimpleNamespace(META={}), f, 480, files.CACHE_PRIVATE)
    assert res.status_code == 200 and holds == [False]


def test_password_verification_runs_without_a_connection(monkeypatch):
    from agrotrace.core.problem import AppProblem
    from agrotrace.modules.auth import services

    holds = []
    monkeypatch.setattr(services, "dummy_verify", lambda pw: holds.append(sql.holds_connection()))
    with pytest.raises(AppProblem):
        services.login({"email": "nobody.holder@agrotrace.test", "password": "whatever-password"})
    assert holds == [False]


def test_a_flood_of_slow_non_db_work_does_not_starve_other_queries(monkeypatch):
    """20 threads (pool max 7) each run a query, then 1 s of non-DB work (as a Pillow decode); meanwhile other
    queries stay fast and none waits for the pool (before the fix: ~1 s+ waits, and 503 past 5 s)."""
    from agrotrace.modules.files import services as files

    def slow_variants(data, mime, cancelled=None):
        time.sleep(1.0)
        return {"96": b"x", "480": b"y"}

    monkeypatch.setattr("agrotrace.infra.images.variants", slow_variants)
    errors = []

    def heavy():
        try:
            files.prepare(Upload("a.png", png(4, 4)), kind="AVATAR", owner_id=None, allowed=("image/png",))
        except Exception as e:  # noqa: BLE001
            errors.append(e)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=heavy) for _ in range(20)]
    for t in threads:
        t.start()
    time.sleep(0.2)
    worst = 0.0
    for _ in range(10):
        t0 = time.monotonic()
        assert sql.scalar("SELECT 1") == 1
        worst = max(worst, time.monotonic() - t0)
        time.sleep(0.05)
    for t in threads:
        t.join()
    assert errors == []
    assert worst < 0.3, worst


# ── guard: every statement goes through the releasing helpers ────────────────────────────────────────────────────

PKG = Path(agrotrace.__file__).parent
#: Modules allowed to touch Django's connection directly (the helpers themselves and the session-level code).
DIRECT_ALLOWED = {"core/sql.py", "core/tx.py", "core/locks.py", "scheduler/runner.py", "modules/health/views.py",
                  "core/views.py"}


def test_no_direct_cursor_outside_the_helpers():
    bad = []
    for p in sorted(PKG.rglob("*.py")):
        rel = p.relative_to(PKG).as_posix()
        if rel in DIRECT_ALLOWED:
            continue
        bad += [f"{rel}:{line} {what}" for line, what in _forbidden(ast.parse(p.read_text("utf-8")))]
    assert bad == []


def _forbidden(tree) -> list[tuple[int, str]]:
    """connection.cursor() / connections["default"].cursor() / any ORM manager (Model.objects.…) — they bypass the
    releasing helpers and would hold a connection until the view ends (review N5)."""
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute):
            continue
        base = node.value
        if node.attr == "cursor" and (isinstance(base, ast.Subscript) or getattr(base, "id", "") == "connection"):
            out.append((node.lineno, "cursor"))
        if node.attr == "objects" and isinstance(base, ast.Name) and base.id[:1].isupper():  # a Model's manager
            out.append((node.lineno, "objects"))
    return out


def test_the_guard_sees_the_forms_it_forbids():
    sample = ast.parse('connection.cursor()\nconnections["default"].cursor()\nUser.objects.filter(id=1)\n')
    assert sorted(w for _, w in _forbidden(sample)) == ["cursor", "cursor", "objects"]
