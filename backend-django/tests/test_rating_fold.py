"""BR-09 on agrotrace_test_django (contracts/rules/trust-rating.json, rating.recalculate.schema.json): the rating is a
full left fold from `initial` over the farm's events — DONE, non-deleted lab tests of its non-deleted batches at
`completed_at`, non-deleted recalls whose source it originated at `opened_at` — ordered by time, then lab before
recall, then id by code points. The bounds make the order observable: at 100 a PASS is lost, so (PASS, RECALL) → 90
while (RECALL, PASS) → 92. `recalculate` stores a changed rating with `system.ratingRecalculate`, FARM only."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from agrotrace.core import sql
from agrotrace.core.tx import with_tx
from agrotrace.modules.rating import services as rating
from tests.world import World

T0 = datetime(2026, 9, 1, 8, 0, tzinfo=UTC)


@pytest.fixture
def world(db):
    w = World()
    yield w
    w.cleanup()


def fold(org: str) -> int:
    return with_tx(lambda tx: rating.fold(tx, org))


def at(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


def to_the_top(w: World, farm: str, lab: str) -> str:
    """Ten passes (80 → 100) at minutes 0…9; the batch they were run on."""
    b = w.batch(farm)
    for i in range(10):
        w.lab_test(b, lab, status="DONE", conclusion="PASS", completed_at=at(i))
    return b


def test_no_events_is_the_initial_rating(world):
    assert fold(world.org("FARM")) == 80


def test_time_ascending(world):
    farm, lab = world.org("FARM"), world.org("LAB")
    b = to_the_top(world, farm, lab)
    world.recall(b, opened_at=at(20))
    world.lab_test(b, lab, status="DONE", conclusion="PASS", completed_at=at(30))
    assert fold(farm) == 92  # 100 → recall 90 → pass 92 (a pass first would be lost at the bound: 90)


def test_lab_before_recall_at_the_same_instant(world):
    farm, lab = world.org("FARM"), world.org("LAB")
    b = to_the_top(world, farm, lab)
    world.recall(b, opened_at=at(20))
    world.lab_test(b, lab, status="DONE", conclusion="PASS", completed_at=at(20))
    assert fold(farm) == 90  # pass (lost at 100), then the recall


def test_ids_by_code_points_at_the_same_instant(world):
    farm, lab = world.org("FARM"), world.org("LAB")
    b = to_the_top(world, farm, lab)
    # FAIL first by id ("0…" < "f…"): 100 → 85 → 87; PASS first would give 100 → 100 → 85.
    world.lab_test(b, lab, tid="ffffffff-0000-4000-8000-000000000001", status="DONE", conclusion="PASS",
                   completed_at=at(20))
    world.lab_test(b, lab, tid="00000000-0000-4000-8000-0000000000f1", status="DONE", conclusion="FAIL",
                   completed_at=at(20))
    assert fold(farm) == 87


def test_only_the_farms_live_events_count(world):
    farm, other, lab = world.org("FARM"), world.org("FARM"), world.org("LAB")
    proc = world.org("PROCESSOR")
    mine = world.batch(farm, holder=proc)  # held elsewhere: the origin decides
    gone = world.batch(farm, deleted=True)
    theirs = world.batch(other)
    world.lab_test(mine, lab, status="DONE", conclusion="FAIL", completed_at=at(1))  # −15
    world.lab_test(mine, lab, status="SAMPLED")  # not DONE
    world.lab_test(mine, lab, status="DONE", conclusion="FAIL", completed_at=at(2), deleted=True)
    world.lab_test(gone, lab, status="DONE", conclusion="FAIL", completed_at=at(3))  # deleted batch
    world.lab_test(theirs, lab, status="DONE", conclusion="FAIL", completed_at=at(4))
    world.recall(mine, opened_at=at(5))  # −10
    world.recall(mine, opened_at=at(6), deleted=True)
    world.recall(theirs, opened_at=at(7))
    assert fold(farm) == 55
    assert fold(other) == 55


def test_recalculate_stores_a_change_once_and_ignores_other_types(world):
    farm, lab = world.org("FARM"), world.org("LAB")
    b = world.batch(farm)
    world.lab_test(b, lab, status="DONE", conclusion="FAIL", completed_at=at(1))
    assert with_tx(lambda tx: rating.recalculate(tx, farm)) == (80, 65, True)
    assert sql.scalar("SELECT trust_rating FROM organizations WHERE id = %s", [farm]) == 65
    rows = sql.all("SELECT actor_id, entity_type, diff FROM audit_log WHERE entity_id = %s "
                   "AND action = 'system.ratingRecalculate'", [farm])
    assert [(r["actor_id"], r["entity_type"], sql.jsonb(r["diff"])) for r in rows] == [
        (None, "organization", {"trustRating": [80, 65]})]
    # A full fold, not a delta: handled again it changes nothing and writes no audit row.
    assert with_tx(lambda tx: rating.recalculate(tx, farm)) == (65, 65, False)
    assert sql.scalar("SELECT count(*) FROM audit_log WHERE entity_id = %s", [farm]) == 1
    assert with_tx(lambda tx: rating.recalculate(tx, lab)) == (None, None, False)
    assert with_tx(lambda tx: rating.recalculate(tx, "00000000-0000-4000-8000-000000000000")) == (None, None, False)
