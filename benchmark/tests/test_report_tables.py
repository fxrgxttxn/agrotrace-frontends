"""Report-table generation and verification (Task 5).

`agrobench.report_tables` writes every table of docs/reports/databases.md between markers from the
published CSV/JSON in docs/reports/data/. These tests cover the machinery on synthetic data and
then check the real report: every number in its tables exists in the source files, every generated
block is exactly what the script produces now (so a number edited by hand fails), no table with
numbers lives outside a generated block, and every decimal number quoted in the prose appears in a
generated table. Pure — no stand needed (the published report is mounted at /reports).
"""
from __future__ import annotations

import csv
from pathlib import Path

import pytest

from agrobench import report_tables as rt

NB = " "


# ---------------------------------------------------------------------------------------------
# number formatting
# ---------------------------------------------------------------------------------------------

def test_fmt_num_uses_russian_decimal_comma_and_nbsp_thousands():
    assert rt.fmt_num(143.414, 1) == "143,4"
    assert rt.fmt_num(1075443.583, 1) == f"1{NB}075{NB}443,6"
    assert rt.fmt_num(5526, 0) == f"5{NB}526"
    assert rt.fmt_num(0.955377, 3) == "0,955"
    assert rt.fmt_num(999.96, 1) == f"1{NB}000,0"


# ---------------------------------------------------------------------------------------------
# block rendering
# ---------------------------------------------------------------------------------------------

def _write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


@pytest.fixture
def tiny(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    _write_csv(data / "m.csv", ["query", "p50_us", "bytes"], [["R1", "143.414", "2613248"], ["R2", "278.332", "1449984"]])

    def build(d: rt.Data) -> str:
        rows = d.csv("m.csv")
        lines = ["| Запрос | p50, мкс | Размер, МБ |", "|---|---:|---:|"]
        for r in rows:
            lines.append(f"| {r['query']} | {rt.fmt_num(float(r['p50_us']), 1)} | {rt.fmt_num(float(r['bytes']) / 1e6, 2)} |")
        return "\n".join(lines)

    blocks = {"tiny": rt.Block(sources=("m.csv",), build=build)}
    report = "# Отчёт\n\nТекст.\n\n" + rt.begin("tiny") + "\nstale\n" + rt.end("tiny") + "\n\nКонец.\n"
    return data, blocks, report


def test_render_fills_block_and_is_idempotent(tiny):
    data, blocks, report = tiny
    out = rt.render(report, rt.Data(data), blocks)
    assert "stale" not in out
    assert "| R1 | 143,4 | 2,61 |" in out
    assert out.startswith("# Отчёт\n\nТекст.\n\n") and out.endswith("\n\nКонец.\n")
    assert rt.render(out, rt.Data(data), blocks) == out


def test_render_rejects_unknown_unbalanced_and_duplicate_blocks(tiny):
    data, blocks, _ = tiny
    with pytest.raises(rt.ReportError, match="unknown"):
        rt.render(rt.begin("nope") + "\n" + rt.end("nope"), rt.Data(data), blocks)
    with pytest.raises(rt.ReportError, match="end marker"):
        rt.render(rt.begin("tiny") + "\nx\n", rt.Data(data), blocks)
    twice = (rt.begin("tiny") + "\n" + rt.end("tiny") + "\n") * 2
    with pytest.raises(rt.ReportError, match="more than once"):
        rt.render(twice, rt.Data(data), blocks)


# ---------------------------------------------------------------------------------------------
# number extraction
# ---------------------------------------------------------------------------------------------

def test_table_numbers_skip_header_separator_and_row_label():
    text = "\n".join([
        "| Запрос R9 | p50, мкс |",
        "|---|---:|",
        "| R1 c=16 | 184,9 (184,7–186,6) |",
        f"| W2 | 1{NB}075{NB}443,6 |",
        "не таблица 12,5",
    ])
    assert rt.table_numbers(text) == ["184,9", "184,7", "186,6", f"1{NB}075{NB}443,6"]


def test_source_numbers_include_formatted_and_scaled_forms(tiny):
    data, _, _ = tiny
    allowed = rt.source_numbers(rt.Data(data), ("m.csv",))
    assert {"143,4", "143,41", "143", "0,1", f"2{NB}613{NB}248", "2,6", "2,61", "2,613"} <= allowed
    assert "143,5" not in allowed


# ---------------------------------------------------------------------------------------------
# verification
# ---------------------------------------------------------------------------------------------

def test_verify_accepts_a_freshly_rendered_report(tiny):
    data, blocks, report = tiny
    out = rt.render(report, rt.Data(data), blocks)
    assert rt.verify(out, rt.Data(data), blocks) == []


def test_verify_flags_a_number_edited_by_hand(tiny):
    data, blocks, report = tiny
    edited = rt.render(report, rt.Data(data), blocks).replace("143,4", "143,5")
    problems = rt.verify(edited, rt.Data(data), blocks)
    assert any("tiny" in p and "differs" in p for p in problems)
    assert any("143,5" in p and "not in" in p for p in problems)


def test_verify_flags_an_edit_that_happens_to_match_another_source_value(tiny):
    data, blocks, report = tiny
    # 278,3 is a real value of m.csv, but not for R1: only the regeneration check catches this.
    edited = rt.render(report, rt.Data(data), blocks).replace("| R1 | 143,4", "| R1 | 278,3")
    problems = rt.verify(edited, rt.Data(data), blocks)
    assert problems and all("differs" in p for p in problems)


def test_verify_flags_numeric_table_outside_blocks(tiny):
    data, blocks, report = tiny
    out = rt.render(report, rt.Data(data), blocks) + "\n| Запрос | p50 |\n|---|---|\n| R1 | 150,0 |\n"
    problems = rt.verify(out, rt.Data(data), blocks)
    assert any("outside" in p and "150,0" in p for p in problems)


def test_verify_allows_code_spans_and_labels_in_hand_written_tables(tiny):
    data, blocks, report = tiny
    out = rt.render(report, rt.Data(data), blocks) + "\n| Запрос | Redis |\n|---|---|\n| R3 | `ZREVRANGE k 0 49` |\n"
    assert rt.verify(out, rt.Data(data), blocks) == []


def test_verify_flags_prose_decimal_missing_from_generated_tables(tiny):
    data, blocks, report = tiny
    out = rt.render(report, rt.Data(data), blocks)
    assert rt.verify(out + "\nRedis отвечает за 143,4 мкс.\n", rt.Data(data), blocks) == []
    problems = rt.verify(out + "\nRedis отвечает за 141,0 мкс.\n", rt.Data(data), blocks)
    assert any("prose" in p and "141,0" in p for p in problems)


def test_verify_ignores_numbers_in_fenced_code(tiny):
    data, blocks, report = tiny
    out = rt.render(report, rt.Data(data), blocks) + "\n```\nExecution Time: 0,215 ms\n| 9,9 |\n```\n"
    assert rt.verify(out, rt.Data(data), blocks) == []


# ---------------------------------------------------------------------------------------------
# the real report
# ---------------------------------------------------------------------------------------------

def test_reads_table_takes_uniform_concurrency_1_strict_medians():
    table = rt.BLOCKS["reads_tuned"].build(rt.Data(rt.DATA_DIR))
    r1 = next(line for line in table.splitlines() if line.startswith("| R1 "))
    # measurements_median.csv: pg/tuned/strict/R1/base/uniform/1 p50 184.94, redis 143.414.
    assert "184,9" in r1 and "143,4" in r1


def test_published_report_contains_every_block_and_verifies_against_the_csv():
    report = rt.REPORT_PATH.read_text(encoding="utf-8")
    for name in rt.BLOCKS:
        assert rt.begin(name) in report, name
    assert rt.verify(report, rt.Data(rt.DATA_DIR), rt.BLOCKS) == []
