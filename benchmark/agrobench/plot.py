"""Figures of the database benchmark report (Task 5, spec §13.6).

Reads the published run data (docs/reports/data, via agrobench.report_tables.Data — the same
accessors the report tables use, so a figure and its table can never pick different rows) and
writes PNGs to docs/reports/img/databases/. One style for every figure: light surface, hairline
solid grid, PostgreSQL always blue and Redis always orange, "по умолчанию" always grey, Russian
labels, units мкс / мс / оп/с / МБ / с.

Bars show the median of the three runs; where it matters a thin black whisker shows the min–max of
p50 across the runs (host noise), and a hollow marker shows p95.

    python -m agrobench.plot [--data-dir DIR] [--out-dir DIR]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.ticker import FuncFormatter, MaxNLocator  # noqa: E402

from agrobench import report_tables as rt  # noqa: E402

OUT_DIR = rt.REPORT_DIR / "img" / "databases"

# Palette (dataviz reference instance, light mode): categorical slot 1 / 2, chrome and ink.
PG = "#2a78d6"
PG_LIGHT = "#86b6ef"
REDIS = "#eb6834"
REDIS_LIGHT = "#f4a784"
BASELINE_GREY = "#b8b6ae"
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
COLOR = {"pg": PG, "redis": REDIS}
LIGHT = {"pg": PG_LIGHT, "redis": REDIS_LIGHT}

BAR = 0.36   # bar thickness in a two-bar group (axis units)

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 9,
    "axes.titlesize": 10,
    "axes.titleweight": "bold",
    "axes.titlecolor": INK,
    "axes.labelcolor": INK_2,
    "axes.edgecolor": AXIS,
    "axes.linewidth": 0.8,
    "axes.facecolor": SURFACE,
    "figure.facecolor": SURFACE,
    "savefig.facecolor": SURFACE,
    "xtick.color": MUTED,
    "ytick.color": INK_2,
    "xtick.labelcolor": INK_2,
    "ytick.labelcolor": INK_2,
    "legend.frameon": False,
    "figure.dpi": 150,
})


def _invert_once(ax) -> None:
    """invert_yaxis on shared y axes toggles the shared axis once per call; do it only if needed."""
    if not ax.yaxis_inverted():
        ax.invert_yaxis()


def _num(digits: int = 0):
    return FuncFormatter(lambda v, _pos: rt.fmt_num(v, digits))


def _style(ax, axis: str = "x") -> None:
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    if axis == "x":
        ax.spines["left"].set_visible(False)
        ax.xaxis.set_major_locator(MaxNLocator(6, steps=[1, 2, 2.5, 5, 10]))
        ax.xaxis.grid(True, color=GRID, linewidth=0.8)
        ax.tick_params(axis="y", length=0)
    else:
        ax.spines["bottom"].set_color(AXIS)
        ax.yaxis.grid(True, color=GRID, linewidth=0.8)
        ax.tick_params(axis="x", length=0)
    ax.set_axisbelow(True)


def _whisker(ax, pos: float, lo: float, hi: float, horizontal: bool = True) -> None:
    kw = dict(color=INK, linewidth=0.9, zorder=4)
    cap = BAR * 0.28
    if horizontal:
        ax.plot([lo, hi], [pos, pos], **kw)
        ax.plot([lo, lo], [pos - cap, pos + cap], **kw)
        ax.plot([hi, hi], [pos - cap, pos + cap], **kw)
    else:
        ax.plot([pos, pos], [lo, hi], **kw)
        ax.plot([pos - cap, pos + cap], [lo, lo], **kw)
        ax.plot([pos - cap, pos + cap], [hi, hi], **kw)


def _save(fig, out_dir: Path, name: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / name
    fig.savefig(path, bbox_inches="tight", pad_inches=0.15)
    plt.close(fig)
    return path


def _legend(fig, handles, ncol: int | None = None, y: float = 1.0) -> None:
    fig.legend(handles=handles, loc="lower left", bbox_to_anchor=(0.01, y), ncol=ncol or len(handles),
               handlelength=1.4, columnspacing=1.6, fontsize=9)


def _title(fig, text: str, y: float) -> None:
    fig.suptitle(text, x=0.01, y=y, ha="left", fontsize=11, fontweight="bold", color=INK)


DBMS_HANDLES = [Patch(color=PG, label="PostgreSQL"), Patch(color=REDIS, label="Redis")]
SPREAD_HANDLE = Line2D([], [], color=INK, linewidth=0.9, label="мин–макс p50 по трём прогонам")
P95_HANDLE = Line2D([], [], color=INK, marker="o", markerfacecolor=SURFACE, markersize=5, linewidth=0,
                    label="p95")

READ_LABELS = ["R1", "R2", "R3", "R4", "R5 (PG CTE / Redis Lua)", "R5 (Redis BFS)", "R6"]


# ---------------------------------------------------------------------------------------------
# figures
# ---------------------------------------------------------------------------------------------

def reads_latency(d: rt.Data, out_dir: Path) -> Path:
    """Per read query p50 (bar, run spread) and p95 (marker), PG vs Redis, both profiles."""
    fig, axes = plt.subplots(1, 2, figsize=(10, 4.6), sharey=True, sharex=True)
    for ax, profile in zip(axes, rt.PROFILES):
        for i, (_label, q, pv, rv) in enumerate(rt.READS):
            for j, (dbms, v) in enumerate((("pg", pv), ("redis", rv))):
                if v is None:
                    continue
                r = d.median(dbms, profile, "strict", q, v, "uniform", 1)
                y = i + (j - 0.5) * (BAR + 0.04)
                ax.barh(y, float(r["p50_us"]), height=BAR, color=COLOR[dbms], zorder=3)
                _whisker(ax, y, float(r["p50_us_min"]), float(r["p50_us_max"]))
                ax.plot(float(r["p95_us"]), y, marker="o", markersize=5, markerfacecolor=SURFACE,
                        markeredgecolor=INK, markeredgewidth=0.9, linewidth=0, zorder=5)
        ax.set_yticks(range(len(rt.READS)), READ_LABELS)
        _invert_once(ax)
        ax.set_title(f"Конфигурация «{rt.PROFILE_RU[profile]}»", loc="left")
        ax.set_xlabel("задержка, мкс (1 клиент, равномерные ключи)")
        ax.xaxis.set_major_formatter(_num())
        _style(ax)
    _title(fig, "Чтение: p50 и p95, PostgreSQL и Redis", 1.04)
    _legend(fig, DBMS_HANDLES + [SPREAD_HANDLE, P95_HANDLE], y=0.945)
    return _save(fig, out_dir, "reads_latency.png")


def optimization(d: rt.Data, out_dir: Path) -> Path:
    """Default vs tuned profile per DBMS: p50 at 1 client and ops/s at 16 clients."""
    runs = {dbms: [(lab, q, v) for lab, (_l, q, pv, rv) in zip(READ_LABELS, rt.READS)
                   for v in [pv if dbms == "pg" else rv] if v]
            for dbms in ("pg", "redis")}
    fig, axes = plt.subplots(2, 2, figsize=(10, 6.8), sharex="col", gridspec_kw={"height_ratios": [6, 7]})
    for row, dbms in enumerate(("pg", "redis")):
        items = runs[dbms]
        for col, conc in enumerate((1, 16)):
            ax = axes[row][col]
            for i, (_lab, q, v) in enumerate(items):
                for j, profile in enumerate(rt.PROFILES):
                    r = d.median(dbms, profile, "strict", q, v, "uniform", conc)
                    y = i + (j - 0.5) * (BAR + 0.04)
                    color = BASELINE_GREY if profile == "default" else COLOR[dbms]
                    value = float(r["p50_us"]) if conc == 1 else float(r["ops_s"])
                    ax.barh(y, value, height=BAR, color=color, zorder=3)
                    if conc == 1:
                        _whisker(ax, y, float(r["p50_us_min"]), float(r["p50_us_max"]))
            ax.set_yticks(range(len(items)), [lab for lab, _, _ in items])
            _invert_once(ax)
            ax.xaxis.set_major_formatter(_num())
            if row == 1:
                ax.set_xlabel("p50, мкс (1 клиент)" if conc == 1 else "пропускная способность, оп/с (16 клиентов)")
            ax.set_title(f"{rt.DBMS_RU[dbms]}: " + ("задержка, меньше — лучше" if conc == 1
                                                   else "оп/с, больше — лучше"), loc="left")
            _style(ax)
    _title(fig, "Влияние оптимизации конфигурации на чтение (режим «строгий»)", 1.06)
    _legend(fig, [Patch(color=BASELINE_GREY, label="по умолчанию"),
                  Patch(color=PG, label="оптимизированная, PostgreSQL"),
                  Patch(color=REDIS, label="оптимизированная, Redis"), SPREAD_HANDLE], y=0.985)
    fig.tight_layout(h_pad=2.0)
    return _save(fig, out_dir, "optimization.png")


def prepared(d: rt.Data, out_dir: Path) -> Path:
    """PostgreSQL prepared statements on/off, p50 at 1 client, both profiles."""
    items = [(lab, q, pv) for lab, (_l, q, pv, _rv) in zip(READ_LABELS, rt.READS) if pv]
    labels = [lab.replace(" (PG CTE / Redis Lua)", " (WITH RECURSIVE)") for lab, _, _ in items]
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.6), sharey=True, sharex=True)
    for ax, profile in zip(axes, rt.PROFILES):
        for i, (_lab, q, pv) in enumerate(items):
            for j, variant in enumerate((pv, "unprepared")):
                r = d.median("pg", profile, "strict", q, variant, "uniform", 1)
                y = i + (j - 0.5) * (BAR + 0.04)
                ax.barh(y, float(r["p50_us"]), height=BAR, zorder=3,
                        color=PG if variant != "unprepared" else BASELINE_GREY)
                _whisker(ax, y, float(r["p50_us_min"]), float(r["p50_us_max"]))
        ax.set_yticks(range(len(items)), labels)
        _invert_once(ax)
        ax.set_title(f"Конфигурация «{rt.PROFILE_RU[profile]}»", loc="left")
        ax.set_xlabel("p50, мкс (1 клиент, равномерные ключи)")
        ax.xaxis.set_major_formatter(_num())
        _style(ax)
    _title(fig, "PostgreSQL: подготовленные запросы против разбора каждого вызова", 1.1)
    _legend(fig, [Patch(color=PG, label="подготовленный (prepare_threshold = 5)"),
                  Patch(color=BASELINE_GREY, label="без подготовки"), SPREAD_HANDLE], y=0.98)
    return _save(fig, out_dir, "prepared.png")


DUR_QUERIES = [("W1", "base", "base"), ("W2", "copy", "pipeline"), ("W3", "base", "base"), ("D1", "base", "base")]


def durability(d: rt.Data, out_dir: Path) -> Path:
    """Strict vs relaxed durability: p50 at 1 client for W1, W2, W3, D1 (tuned profile)."""
    fig, axes = plt.subplots(1, 4, figsize=(11, 3.6))
    for ax, (q, pv, rv) in zip(axes, DUR_QUERIES):
        scale = 1e3 if q == "W2" else 1.0
        for i, dur in enumerate(rt.DURABILITIES):
            for j, (dbms, v) in enumerate((("pg", pv), ("redis", rv))):
                r = d.median(dbms, "tuned", dur, q, v, "prepared", 1)
                x = i + (j - 0.5) * (BAR + 0.04)
                ax.bar(x, float(r["p50_us"]) / scale, width=BAR, color=COLOR[dbms], zorder=3)
                _whisker(ax, x, float(r["p50_us_min"]) / scale, float(r["p50_us_max"]) / scale, horizontal=False)
        ax.set_xticks(range(2), [rt.DUR_RU[x] for x in rt.DURABILITIES])
        ax.yaxis.set_major_formatter(_num())
        ax.set_ylabel("p50, мс" if q == "W2" else "p50, мкс")
        title = {"W1": "W1: вставка партии", "W2": "W2: 10 000 партий*", "W3": "W3: смена статуса",
                 "D1": "D1: удаление каскадом"}[q]
        ax.set_title(title, loc="left")
        _style(ax, axis="y")
    _title(fig, "Режим надёжности: запись при 1 клиенте (конфигурация «оптимизированная»)", 1.1)
    _legend(fig, DBMS_HANDLES + [SPREAD_HANDLE], y=0.99)
    fig.text(0.01, -0.04, "* W2: PostgreSQL — COPY, Redis — pipeline из 10 000 × W1; шкала в миллисекундах.",
             color=INK_2, fontsize=8)
    fig.tight_layout(w_pad=2.0)
    return _save(fig, out_dir, "durability.png")


def durability_c16(d: rt.Data, out_dir: Path) -> Path:
    """Strict vs relaxed at 16 clients: ops/s for W1, W3, D1 (tuned profile)."""
    fig, axes = plt.subplots(1, 3, figsize=(10, 3.4), sharey=True)
    for ax, q in zip(axes, rt.WRITES):
        for i, dur in enumerate(rt.DURABILITIES):
            for j, dbms in enumerate(("pg", "redis")):
                r = d.median(dbms, "tuned", dur, q, "base", "prepared", 16)
                x = i + (j - 0.5) * (BAR + 0.04)
                ax.bar(x, float(r["ops_s"]), width=BAR, color=COLOR[dbms], zorder=3)
        ax.set_xticks(range(2), [rt.DUR_RU[x] for x in rt.DURABILITIES])
        ax.yaxis.set_major_formatter(_num())
        ax.set_title(q, loc="left")
        _style(ax, axis="y")
    axes[0].set_ylabel("оп/с, 16 клиентов")
    _title(fig, "Режим надёжности: пропускная способность записи при 16 клиентах", 1.1)
    _legend(fig, DBMS_HANDLES, y=0.99)
    fig.tight_layout(w_pad=2.0)
    return _save(fig, out_dir, "durability_c16.png")


def bulk(d: rt.Data, out_dir: Path) -> Path:
    """W2 (both PG variants vs Redis pipeline) and D2, p50 in ms, all four configurations."""
    configs = [(p, dur) for p in rt.PROFILES for dur in rt.DURABILITIES]
    config_labels = [f"{rt.PROFILE_RU[p]}\n{rt.DUR_RU[dur]}" for p, dur in configs]
    series = {"W2": [("pg", "copy", PG), ("pg", "multirow", PG_LIGHT), ("redis", "pipeline", REDIS)],
              "D2": [("pg", "base", PG), ("redis", "base", REDIS)]}
    fig, axes = plt.subplots(1, 2, figsize=(13, 3.8))
    for ax, q in zip(axes, ("W2", "D2")):
        ss = series[q]
        width = 0.8 / len(ss)
        for i, (p, dur) in enumerate(configs):
            for j, (dbms, v, color) in enumerate(ss):
                r = d.median(dbms, p, dur, q, v, "prepared", 1)
                x = i + (j - (len(ss) - 1) / 2) * width
                ax.bar(x, float(r["p50_us"]) / 1e3, width=width * 0.9, color=color, zorder=3)
                _whisker(ax, x, float(r["p50_us_min"]) / 1e3, float(r["p50_us_max"]) / 1e3, horizontal=False)
        ax.set_xticks(range(len(configs)), config_labels, fontsize=8)
        ax.yaxis.set_major_formatter(_num())
        ax.set_ylabel("p50, мс")
        ax.set_title("W2: вставка 10 000 партий одним вызовом" if q == "W2"
                     else "D2: удаление 1 000 анализов по сроку", loc="left")
        _style(ax, axis="y")
    _title(fig, "Пакетные операции, 1 клиент", 1.1)
    _legend(fig, [Patch(color=PG, label="PostgreSQL (W2: COPY)"),
                  Patch(color=PG_LIGHT, label="PostgreSQL (W2: multi-row INSERT)"),
                  Patch(color=REDIS, label="Redis (W2: pipeline)"), SPREAD_HANDLE], y=0.99)
    fig.tight_layout(w_pad=2.5)
    return _save(fig, out_dir, "bulk.png")


def scaling(d: rt.Data, out_dir: Path) -> Path:
    """1 -> 16 clients: ops/s of every read query, PG vs Redis (tuned profile)."""
    fig, axes = plt.subplots(1, 2, figsize=(10, 4.4), sharey=True, sharex=True)
    for ax, conc in zip(axes, (1, 16)):
        for i, (_label, q, pv, rv) in enumerate(rt.READS):
            for j, (dbms, v) in enumerate((("pg", pv), ("redis", rv))):
                if v is None:
                    continue
                r = d.median(dbms, "tuned", "strict", q, v, "uniform", conc)
                y = i + (j - 0.5) * (BAR + 0.04)
                ax.barh(y, float(r["ops_s"]), height=BAR, color=COLOR[dbms], zorder=3)
        ax.set_yticks(range(len(rt.READS)), READ_LABELS)
        _invert_once(ax)
        ax.set_title("1 клиент" if conc == 1 else "16 клиентов (8 процессов × 2)", loc="left")
        ax.set_xlabel("пропускная способность, оп/с")
        ax.xaxis.set_major_formatter(_num())
        _style(ax)
    _title(fig, "Масштабирование чтения 1 → 16 клиентов (конфигурация «оптимизированная»)", 1.08)
    _legend(fig, DBMS_HANDLES, y=0.98)
    return _save(fig, out_dir, "scaling.png")


def memory(d: rt.Data, out_dir: Path) -> Path:
    """PG size per table (data + indexes), Redis MEMORY USAGE per key type, and totals (MB)."""
    p, dur = "tuned", "strict"
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.2), gridspec_kw={"width_ratios": [4, 5, 5]})
    ax = axes[0]
    for i, t in enumerate(rt.PG_TABLES):
        data = float(d.memory("pg", p, dur, t, "table_bytes")) / 1e6
        idx = float(d.memory("pg", p, dur, t, "indexes_bytes")) / 1e6
        ax.barh(i, data, height=0.5, color=PG, zorder=3)
        ax.barh(i, idx, left=data, height=0.5, color=PG_LIGHT, zorder=3, edgecolor=SURFACE, linewidth=1.5)
    ax.set_yticks(range(len(rt.PG_TABLES)), rt.PG_TABLES)
    _invert_once(ax)
    ax.set_title("PostgreSQL: таблицы на диске", loc="left")
    ax.set_xlabel("МБ")
    ax.xaxis.set_major_formatter(_num(1))
    ax.legend(handles=[Patch(color=PG, label="данные"), Patch(color=PG_LIGHT, label="индексы")],
              loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=2, fontsize=8)
    _style(ax)

    ax = axes[1]
    keys = rt.REDIS_KEYS
    for i, (key, _label) in enumerate(keys):
        ax.barh(i, float(d.memory("redis", p, dur, key, "extrapolated_bytes")) / 1e6, height=0.6, color=REDIS, zorder=3)
    ax.set_yticks(range(len(keys)), [label.split("`")[1] for _k, label in keys], fontsize=8)
    _invert_once(ax)
    ax.set_title("Redis: память по типам ключей (оценка)", loc="left")
    ax.set_xlabel("МБ (MEMORY USAGE выборки × число ключей)")
    ax.xaxis.set_major_formatter(_num(1))
    _style(ax)

    ax = axes[2]
    tables = sum(float(d.memory("pg", p, dur, t, "total_relation_size_bytes")) for t in rt.PG_TABLES)
    totals = [
        ("PG: 4 таблицы с индексами", tables, PG),
        ("PG: база целиком (с каталогом)", float(d.memory("pg", p, dur, "__database__", "total_bytes")), PG_LIGHT),
        ("Redis: used_memory_dataset", float(d.memory("redis", p, dur, "__instance__", "used_memory_dataset")), REDIS),
        ("Redis: used_memory", float(d.memory("redis", p, dur, "__instance__", "used_memory")), REDIS),
        ("Redis: RSS процесса", float(d.memory("redis", p, dur, "__instance__", "used_memory_rss")), REDIS),
    ]
    for i, (_label, v, color) in enumerate(totals):
        ax.barh(i, v / 1e6, height=0.5, color=color, zorder=3)
        note = "" if i == 0 else f" ({rt.fmt_num(v / tables, 2)}×)"
        ax.text(v / 1e6, i, " " + rt.fmt_num(v / 1e6, 1) + note, va="center", ha="left", color=INK_2, fontsize=8)
    ax.set_yticks(range(len(totals)), [t[0] for t in totals])
    _invert_once(ax)
    ax.set_title("Итого (× — к таблицам PG с индексами)", loc="left")
    ax.set_xlabel("МБ")
    ax.set_xlim(0, max(v for _l, v, _c in totals) / 1e6 * 1.45)
    ax.xaxis.set_major_formatter(_num())
    _style(ax)
    _title(fig, "Объём данных: 10 000 записей каждой сущности (конфигурация «оптимизированная», «строгий»)", 1.03)
    fig.tight_layout(w_pad=2.5)
    return _save(fig, out_dir, "memory.png")


def load_time(d: rt.Data, out_dir: Path) -> Path:
    """Load time per configuration: PG COPY + indexes/ANALYZE stacked, Redis pipeline."""
    configs = [(p, dur) for p in rt.PROFILES for dur in rt.DURABILITIES]
    fig, ax = plt.subplots(figsize=(9, 3.8))
    for i, (p, dur) in enumerate(configs):
        copy = sum(float(d.load("pg", p, dur, ph)) for ph in
                   ("copy_organizations", "copy_batches", "copy_batch_links", "copy_lab_tests"))
        idx = float(d.load("pg", p, dur, "indexes_and_analyze"))
        y_pg, y_rd = i - (BAR + 0.04) / 2, i + (BAR + 0.04) / 2
        ax.barh(y_pg, copy, height=BAR, color=PG, zorder=3)
        ax.barh(y_pg, idx, left=copy, height=BAR, color=PG_LIGHT, zorder=3, edgecolor=SURFACE, linewidth=1.5)
        ax.barh(y_rd, float(d.load("redis", p, dur, "total")), height=BAR, color=REDIS, zorder=3)
    ax.set_yticks(range(len(configs)), [f"{rt.PROFILE_RU[p]}, {rt.DUR_RU[dur]}" for p, dur in configs])
    _invert_once(ax)
    ax.set_xlabel("время загрузки, с (по одному замеру на конфигурацию)")
    ax.xaxis.set_major_formatter(_num(2))
    _style(ax)
    _title(fig, "Загрузка 4 × 10 000 записей", 1.1)
    _legend(fig, [Patch(color=PG, label="PostgreSQL: COPY четырёх таблиц"),
                  Patch(color=PG_LIGHT, label="PostgreSQL: индексы + ANALYZE"),
                  Patch(color=REDIS, label="Redis: pipeline по 10 000 команд")], y=0.99)
    return _save(fig, out_dir, "load.png")


FIGURES = [reads_latency, optimization, prepared, durability, durability_c16, bulk, scaling, memory, load_time]


def plot_all(data_dir: Path = rt.DATA_DIR, out_dir: Path = OUT_DIR) -> list[Path]:
    d = rt.Data(data_dir)
    return [fig(d, out_dir) for fig in FIGURES]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=rt.DATA_DIR)
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = parser.parse_args(argv)
    for path in plot_all(args.data_dir, args.out_dir):
        print(f"plot: {path}")


if __name__ == "__main__":
    main()
