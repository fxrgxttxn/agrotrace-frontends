"""Recomputes every Redis secondary structure (spec §13.3: code, held, held:status, stats,
children/parents, link hashes, tests list, tests:by_due) from the primary hashes (batch:*, test:*)
and the link:*:* edge hashes, then compares against what is actually stored. Also checks
referential integrity (fix round 1, Minor 9): every link:*:* hash's parent/child and every test's
batch_id must point at a batch that still exists. Used after every write/delete in the equivalence
tests (Review Focus 2) and by test_redis_invariants.py to prove the checker itself catches a
planted inconsistency.

A full keyspace SCAN is the one place in this benchmark that's allowed: everywhere else (spec
§13.6 "отказ от KEYS") is about not paying SCAN/KEYS cost on a *measured* query path; this is a
one-shot test/audit tool, run against the small (--scale 500) test dataset, never timed.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict

from agrobench import redis_keys

SCORE_TOLERANCE = 1e-6

_CODE_RE = re.compile(r"^batch:code:(.+)$")
_HELD_STATUS_RE = re.compile(r"^org:(\d+):held:(.+)$")
_HELD_RE = re.compile(r"^org:(\d+):held$")
_CHILDREN_RE = re.compile(r"^batch:(\d+):children$")
_PARENTS_RE = re.compile(r"^batch:(\d+):parents$")
_TESTS_LIST_RE = re.compile(r"^batch:(\d+):tests$")
_STATS_RE = re.compile(r"^stats:org:(\d+)$")
_BATCH_RE = re.compile(r"^batch:(\d+)$")
_TEST_RE = re.compile(r"^test:(\d+)$")
_LINK_RE = re.compile(r"^link:(\d+):(\d+)$")


def _classify_keys(r) -> dict[str, list[tuple]]:
    """One full SCAN, classifying every key by which spec §13.3 structure it belongs to. Order
    matters: more specific patterns (batch:code:*, batch:{id}:children/parents/tests) must be
    checked before the plain batch:{id} hash pattern, which would otherwise also match them."""
    by_kind: dict[str, list[tuple]] = defaultdict(list)
    due_key = redis_keys.tests_by_due_key()
    for key in r.scan_iter(match="*", count=1000):
        m = _CODE_RE.match(key)
        if m:
            by_kind["code"].append((key, m.group(1)))
            continue
        m = _HELD_STATUS_RE.match(key)
        if m:
            by_kind["held_status"].append((key, m.group(1), m.group(2)))
            continue
        m = _HELD_RE.match(key)
        if m:
            by_kind["held"].append((key, m.group(1)))
            continue
        m = _CHILDREN_RE.match(key)
        if m:
            by_kind["children"].append((key, m.group(1)))
            continue
        m = _PARENTS_RE.match(key)
        if m:
            by_kind["parents"].append((key, m.group(1)))
            continue
        m = _TESTS_LIST_RE.match(key)
        if m:
            by_kind["tests_list"].append((key, m.group(1)))
            continue
        m = _STATS_RE.match(key)
        if m:
            by_kind["stats"].append((key, m.group(1)))
            continue
        if key == due_key:
            by_kind["tests_by_due"].append((key,))
            continue
        m = _BATCH_RE.match(key)
        if m:
            by_kind["batch"].append((key, m.group(1)))
            continue
        m = _TEST_RE.match(key)
        if m:
            by_kind["test"].append((key, m.group(1)))
            continue
        m = _LINK_RE.match(key)
        if m:
            by_kind["link"].append((key, m.group(1), m.group(2)))
            continue
        # org:{id} and seq:{entity} are primary/bookkeeping keys with no derived secondary
        # structure of their own — nothing to recompute or check them against.
    return by_kind


def assert_redis_invariants(r) -> None:
    """Raises AssertionError (with every mismatch found, not just the first) if any secondary
    structure disagrees with what the primary batch:*/test*/link:*:* hashes imply."""
    by_kind = _classify_keys(r)
    errors: list[str] = []

    batches: dict[str, dict] = {bid: r.hgetall(key) for key, bid in by_kind["batch"]}
    tests: dict[str, dict] = {tid: r.hgetall(key) for key, tid in by_kind["test"]}
    links: set[tuple[str, str]] = {(p, c) for _, p, c in by_kind["link"]}

    # --- referential integrity (fix round 1, Minor 9): no link or test left pointing at a batch
    # that no longer exists. A half-applied D1 (e.g. the neighbour-edge cleanup running but the
    # batch hash itself surviving, or vice versa) would show up here even when every *other* check
    # above happens to still balance (e.g. a dangling link:*:* hash whose parent/child sets were
    # already cleaned up correctly wouldn't be caught by the children/parents comparisons alone). ---
    for parent, child in sorted(links):
        if parent not in batches:
            errors.append(f"link:{parent}:{child} references missing parent batch:{parent}")
        if child not in batches:
            errors.append(f"link:{parent}:{child} references missing child batch:{child}")

    for tid, t in sorted(tests.items()):
        if t["batch_id"] not in batches:
            errors.append(f"test:{tid} references missing batch:{t['batch_id']}")

    # --- expected, recomputed purely from the primary data above ---
    expected_code: dict[str, str] = {}
    expected_held: dict[str, dict[str, float]] = defaultdict(dict)
    expected_held_status: dict[tuple[str, str], dict[str, float]] = defaultdict(dict)
    expected_stats: dict[str, Counter] = defaultdict(Counter)
    for bid, b in batches.items():
        expected_code[b["public_code"]] = bid
        score = redis_keys.to_score(b["harvested_at"])
        holder = b["holder_org_id"]
        expected_held[holder][bid] = score
        expected_held_status[(holder, b["status"])][bid] = score
        expected_stats[holder][b["status"]] += 1

    expected_children: dict[str, set[str]] = defaultdict(set)
    expected_parents: dict[str, set[str]] = defaultdict(set)
    for parent, child in links:
        expected_children[parent].add(child)
        expected_parents[child].add(parent)

    expected_tests_list: dict[str, set[str]] = defaultdict(set)
    expected_tests_by_due: dict[str, float] = {}
    for tid, t in tests.items():
        expected_tests_list[t["batch_id"]].add(tid)
        expected_tests_by_due[tid] = redis_keys.to_score(t["due_at"])

    # --- actual, read from the live secondary structures found by the scan ---
    actual_code = {code: r.get(key) for key, code in by_kind["code"]}

    actual_held: dict[str, dict[str, float]] = {}
    for key, org_id in by_kind["held"]:
        actual_held[org_id] = {m: s for m, s in r.zrange(key, 0, -1, withscores=True)}

    actual_held_status: dict[tuple[str, str], dict[str, float]] = {}
    for key, org_id, status in by_kind["held_status"]:
        actual_held_status[(org_id, status)] = {m: s for m, s in r.zrange(key, 0, -1, withscores=True)}

    actual_stats: dict[str, dict[str, int]] = {}
    for key, org_id in by_kind["stats"]:
        h = r.hgetall(key)
        # A status count decremented to exactly 0 (W3/D1) legitimately leaves the field behind
        # (HINCRBY doesn't delete fields) — that's not an inconsistency, so zero entries are
        # dropped before comparing, same as `expected_stats` never creating one in the first place.
        actual_stats[org_id] = {status: int(v) for status, v in h.items() if int(v) != 0}

    actual_children: dict[str, set[str]] = {}
    for key, bid in by_kind["children"]:
        actual_children[bid] = set(r.smembers(key))

    actual_parents: dict[str, set[str]] = {}
    for key, bid in by_kind["parents"]:
        actual_parents[bid] = set(r.smembers(key))

    actual_tests_list: dict[str, list[str]] = {}
    for key, bid in by_kind["tests_list"]:
        actual_tests_list[bid] = r.lrange(key, 0, -1)

    actual_tests_by_due: dict[str, float] = {}
    for key, in by_kind["tests_by_due"]:
        actual_tests_by_due = {m: s for m, s in r.zrange(key, 0, -1, withscores=True)}

    # --- compare ---
    if actual_code != expected_code:
        errors.append(f"batch:code:* index mismatch: expected {expected_code}, got {actual_code}")

    if actual_held.keys() != expected_held.keys():
        errors.append(f"org:*:held key set mismatch: expected orgs {sorted(expected_held)}, "
                       f"got {sorted(actual_held)}")
    for org_id, expected in expected_held.items():
        actual = actual_held.get(org_id, {})
        if actual.keys() != expected.keys():
            errors.append(f"org:{org_id}:held membership mismatch: expected {sorted(expected)}, "
                           f"got {sorted(actual)}")
            continue
        for bid, score in expected.items():
            if abs(actual[bid] - score) > SCORE_TOLERANCE:
                errors.append(f"org:{org_id}:held score for batch {bid}: expected {score}, got {actual[bid]}")

    if actual_held_status.keys() != expected_held_status.keys():
        errors.append(f"org:*:held:{{status}} key set mismatch: expected {sorted(expected_held_status)}, "
                       f"got {sorted(actual_held_status)}")
    for (org_id, status), expected in expected_held_status.items():
        actual = actual_held_status.get((org_id, status), {})
        if actual.keys() != expected.keys():
            errors.append(f"org:{org_id}:held:{status} membership mismatch: expected {sorted(expected)}, "
                           f"got {sorted(actual)}")
            continue
        for bid, score in expected.items():
            if abs(actual[bid] - score) > SCORE_TOLERANCE:
                errors.append(
                    f"org:{org_id}:held:{status} score for batch {bid}: expected {score}, got {actual[bid]}"
                )

    all_stats_orgs = set(expected_stats) | set(actual_stats)
    for org_id in all_stats_orgs:
        expected = dict(expected_stats.get(org_id, {}))
        actual = actual_stats.get(org_id, {})
        if actual != expected:
            errors.append(f"stats:org:{org_id} mismatch: expected {expected}, got {actual}")

    all_children_batches = set(expected_children) | set(actual_children)
    for bid in all_children_batches:
        expected = expected_children.get(bid, set())
        actual = actual_children.get(bid, set())
        if actual != expected:
            errors.append(f"batch:{bid}:children mismatch: expected {expected}, got {actual}")

    all_parents_batches = set(expected_parents) | set(actual_parents)
    for bid in all_parents_batches:
        expected = expected_parents.get(bid, set())
        actual = actual_parents.get(bid, set())
        if actual != expected:
            errors.append(f"batch:{bid}:parents mismatch: expected {expected}, got {actual}")

    all_tests_list_batches = set(expected_tests_list) | set(actual_tests_list)
    for bid in all_tests_list_batches:
        expected = expected_tests_list.get(bid, set())
        actual_list = actual_tests_list.get(bid, [])
        actual_set = set(actual_list)
        if len(actual_list) != len(actual_set):
            errors.append(f"batch:{bid}:tests has duplicate members: {actual_list}")
        if actual_set != expected:
            errors.append(f"batch:{bid}:tests mismatch: expected {expected}, got {actual_set}")

    if actual_tests_by_due != expected_tests_by_due:
        if actual_tests_by_due.keys() != expected_tests_by_due.keys():
            errors.append(
                f"tests:by_due membership mismatch: expected {sorted(expected_tests_by_due)}, "
                f"got {sorted(actual_tests_by_due)}"
            )
        else:
            for tid, score in expected_tests_by_due.items():
                if abs(actual_tests_by_due[tid] - score) > SCORE_TOLERANCE:
                    errors.append(
                        f"tests:by_due score for test {tid}: expected {score}, got {actual_tests_by_due[tid]}"
                    )

    if errors:
        raise AssertionError("Redis invariant violations:\n" + "\n".join(errors))
