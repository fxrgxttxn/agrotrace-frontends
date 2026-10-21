"""
Unit suite of backend-django (`./at.sh django:test [pytest args…]`): Django is set up once over the process
configuration of the image (.env + the api-django service environment); the database is agrotrace_test_django
(TEST_DATABASE_URL, role agrotrace_app — the hook sets it). Tests that write clean up their own rows.
"""

from __future__ import annotations

import os

import django
import pytest

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agrotrace.settings")
django.setup()


@pytest.fixture
def db():
    """The test database (never the dev DB): its URL, after checking the alias points at agrotrace_test_django."""
    from django.db import connection

    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.fail("TEST_DATABASE_URL is not set — run the suite with ./at.sh django:test")
    assert connection.settings_dict["NAME"] == "agrotrace_test_django", connection.settings_dict["NAME"]
    yield url
    from django.db import connections

    connections.close_all()


@pytest.fixture
def other_session(db):
    """A second, independent session on the test DB (psycopg, autocommit)."""
    import psycopg

    conn = psycopg.connect(db, autocommit=True)
    yield conn
    conn.close()
