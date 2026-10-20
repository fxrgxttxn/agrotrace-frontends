"""Dataset profile (Task 5 fix round 1): the generated CSVs summarised into dataset.csv, so the
report can quote the real shares, depth and parent counts of the loaded data. Pure — no stand."""
from __future__ import annotations

from collections import Counter

from agrobench import dataset_profile as dp
from agrobench.generate import generate, write_csv


def test_profile_counts_match_the_generated_data(tmp_path):
    g = generate(500, 42)
    for name, rows in (("organizations", g.organizations), ("batches", g.batches),
                       ("batch_links", g.batch_links), ("lab_tests", g.lab_tests)):
        write_csv(rows, tmp_path / f"{name}.csv")
    (tmp_path / "generate.json").write_text('{"scale": 500, "seed": 42}', encoding="utf-8")
    p = dict(dp.profile(tmp_path))
    assert p["rows_batches"] == 500 and p["rows_batch_links"] == len(g.batch_links)
    assert p["batches_raw"] + p["batches_derived"] == 500
    assert p["status_Approved"] == sum(b["status"] == "Approved" for b in g.batches)
    assert p["lab_tests_fail"] == sum(t["conclusion"] == "FAIL" for t in g.lab_tests)
    parents = Counter(Counter(link["child_id"] for link in g.batch_links).values())
    assert all(p[f"derived_with_{k}_parents"] == parents.get(k, 0) for k in (1, 2, 3, 4))
    assert 1 <= p["max_depth"] <= p["spec_max_depth"] == 12
    assert p["spec_status_share_Approved"] == 0.45 and p["spec_fail_share"] == 0.03


def test_max_depth_is_the_longest_path_in_the_dag(tmp_path):
    links = [{"parent_id": 1, "child_id": 2}, {"parent_id": 2, "child_id": 3}, {"parent_id": 1, "child_id": 3}]
    assert dp.max_depth(links) == 2


def test_profile_records_the_seed_generate_actually_used(tmp_path):
    generate_main = __import__("agrobench.generate", fromlist=["main"]).main
    generate_main(["--scale", "200", "--seed", "7", "--out-dir", str(tmp_path)])
    p = dict(dp.profile(tmp_path))
    assert p["seed"] == 7 and p["scale"] == 200
