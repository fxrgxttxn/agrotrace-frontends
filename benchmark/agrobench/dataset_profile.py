"""Profile of the generated dataset (spec §13.4), for the report (Task 5).

Reads the four CSVs `agrobench.generate` wrote (benchmark/data/, the exact files both DBMS were
loaded from) and writes `results/dataset.csv` (metric,value): row counts, RAW/DERIVED split,
status counts, FAIL count, number of parents per derived batch, the DAG's longest path, and the
generator's target parameters (`spec_*`) next to them. `bench.sh publish` copies it to
docs/reports/data/, where agrobench.report_tables turns it into the report's dataset table.

    python -m agrobench.dataset_profile [--data-dir DIR] [--results-dir DIR]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

from agrobench import config, generate


def _read(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def max_depth(links: list[dict]) -> int:
    """Longest path (in edges) of the DAG given as parent/child links."""
    children: dict[str, list[str]] = defaultdict(list)
    nodes: set[str] = set()
    for link in links:
        p, c = str(link["parent_id"]), str(link["child_id"])
        children[p].append(c)
        nodes |= {p, c}
    depth = {n: 0 for n in nodes}
    # Kahn's order over the DAG; depth = longest distance from any root.
    indeg = Counter(str(link["child_id"]) for link in links)
    queue = [n for n in nodes if indeg[n] == 0]
    while queue:
        n = queue.pop()
        for c in children[n]:
            depth[c] = max(depth[c], depth[n] + 1)
            indeg[c] -= 1
            if indeg[c] == 0:
                queue.append(c)
    return max(depth.values(), default=0)


def _generated_with(data_dir: Path) -> list[tuple[str, float]]:
    """scale and seed as recorded by agrobench.generate next to the CSVs (generate.json)."""
    meta = json.loads((Path(data_dir) / "generate.json").read_text(encoding="utf-8"))
    return [("scale", meta["scale"]), ("seed", meta["seed"])]


def profile(data_dir: Path) -> list[tuple[str, float]]:
    data_dir = Path(data_dir)
    orgs = _read(data_dir / "organizations.csv")
    batches = _read(data_dir / "batches.csv")
    links = _read(data_dir / "batch_links.csv")
    tests = _read(data_dir / "lab_tests.csv")
    out: list[tuple[str, float]] = [
        ("rows_organizations", len(orgs)), ("rows_batches", len(batches)),
        ("rows_batch_links", len(links)), ("rows_lab_tests", len(tests)),
        ("batches_raw", sum(b["kind"] == "RAW" for b in batches)),
        ("batches_derived", sum(b["kind"] == "DERIVED" for b in batches)),
    ]
    statuses = Counter(b["status"] for b in batches)
    for status in list(generate.STATUS_SHARE) + generate.OTHER_STATUSES:
        out.append((f"status_{status}", statuses.get(status, 0)))
    out.append(("lab_tests_fail", sum(t["conclusion"] == "FAIL" for t in tests)))
    per_child = Counter(Counter(link["child_id"] for link in links).values())
    for k in (1, 2, 3, 4):
        out.append((f"derived_with_{k}_parents", per_child.get(k, 0)))
    out.append(("max_depth", max_depth(links)))
    out += [
        ("spec_raw_share", generate.RAW_SHARE),
        *[(f"spec_status_share_{s}", share) for s, share in generate.STATUS_SHARE.items()],
        ("spec_fail_share", generate.FAIL_SHARE),
        ("spec_max_depth", generate.MAX_DEPTH),
        *_generated_with(data_dir),
    ]
    return out


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("DATA_DIR", str(config.BENCH_DIR / "data"))))
    parser.add_argument("--results-dir", type=Path,
                        default=Path(os.environ.get("RESULTS_DIR", str(config.BENCH_DIR / "results"))))
    args = parser.parse_args(argv)
    missing = [n for n in ("organizations.csv", "batches.csv", "batch_links.csv", "lab_tests.csv", "generate.json")
               if not (args.data_dir / n).exists()]
    if missing:
        print(f"dataset_profile: {args.data_dir} has no {', '.join(missing)} — run ./at bench gen first",
              file=sys.stderr)
        raise SystemExit(1)
    args.results_dir.mkdir(parents=True, exist_ok=True)
    path = args.results_dir / "dataset.csv"
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["metric", "value"])
        w.writerows(profile(args.data_dir))
    print(f"dataset_profile: {path}")


if __name__ == "__main__":
    main()
