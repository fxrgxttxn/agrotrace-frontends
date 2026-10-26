"""infra.i18n.notification_message against @agrotrace/i18n `notificationMessage` (R87): every part of every type of
contracts/rules/notifications.json (both events of RECALL and RECALL_TASK, labelled and unlabelled enum codes, `*At`
instants and a non-instant `*At`) equals the literal the TypeScript package renders — notification_texts.json was
written by running packages/i18n/src (createT('ru')) under tsx in the tools image on the same payloads. Plus the
ru plurals of `t` (`Intl.PluralRules('ru')`) and the date formatters."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agrotrace.core import config
from agrotrace.infra import i18n

CASES = json.loads((Path(__file__).parent / "notification_texts.json").read_text("utf-8"))
PARTS = ("title", "body", "email.subject", "email.body", "telegram")


def test_every_type_of_the_rules_file_is_covered():
    rules = json.loads((config.ROOT / "contracts" / "rules" / "notifications.json").read_text("utf-8"))
    assert {c["type"] for c in CASES} == set(rules["types"])
    for c in CASES:
        assert set(c["payload"]) == set(rules["types"][c["type"]]["payload"])


@pytest.mark.parametrize("case", CASES, ids=[f"{i}-{c['type']}" for i, c in enumerate(CASES)])
@pytest.mark.parametrize("part", PARTS)
def test_notification_message_equals_the_typescript_output(case, part):
    out = i18n.notification_message(case["type"], case["payload"], part)
    assert out == case["parts"][part]
    assert "{" not in out, "an unsubstituted parameter"


#: `createT('ru')('count.batches', {count})` from the TypeScript package (the one plural template of ru.json).
PLURALS = {0: "0 партий", 1: "1 партия", 2: "2 партии", 4: "4 партии", 5: "5 партий", 11: "11 партий",
           12: "12 партий", 14: "14 партий", 21: "21 партия", 22: "22 партии", 25: "25 партий", 101: "101 партия",
           111: "111 партий", 1.5: "1.5 партий"}


@pytest.mark.parametrize("n", list(PLURALS))
def test_ru_plurals(n):
    assert i18n.t("count.batches", {"count": n}) == PLURALS[n]


def test_a_count_that_is_not_a_number_leaves_the_plural_template():
    assert i18n.t("count.batches", {"count": "3"}) == \
        "{count, plural, one {# партия} few {# партии} many {# партий} other {# партий}}"


def test_formatters():
    assert i18n.format_date("2026-09-25", "ru") == "25.09.2026"
    assert i18n.format_date_time("2026-09-25T15:00:59.999Z", "ru") == "25.09.2026 15:00"
    assert i18n.format_date_time("2026-09-25T15:00:00.000Z", "en") == "09/25/2026 15:00"
    assert i18n.t("no.such.key") == "no.such.key"
