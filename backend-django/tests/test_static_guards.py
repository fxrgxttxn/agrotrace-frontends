"""
Static guards over agrotrace/ (Review Focus 1, 2, 5), on the AST — comments and docstrings do not count, SQL strings
do:
- P43: no process clock and no statement clock in written data and deadline rules — `Now()` (STATEMENT_TIMESTAMP),
  `auto_now`/`auto_now_add`, `timezone.now()`, `datetime.now()`, `date.today()` in modules/, events/, scheduler/,
  core/ (exceptions: the files below, whose clock is not written data);
- P57: no `select_for_update()` without `no_key=True`, no `FOR UPDATE` in SQL and no `lock(..., strength='update')`
  outside ALLOWED (dictionary row deletion — Task 4, deleteField — Task 5);
- outbox only (R55): no `.delay()`, `.apply_async()`, `.retry()` outside infra/relay.py and events/tasks.py;
- no floats in decimal or rating arithmetic: the whole package, with FLOAT_EXCEPTIONS and duration names.
"""

import ast
import re
from pathlib import Path

import agrotrace

PKG = Path(agrotrace.__file__).parent
CLOCK_DIRS = ("modules", "events", "scheduler", "core")
CLOCK_EXCEPTIONS = {"security/jwt.py", "infra/altcha.py", "infra/file_urls.py", "core/logging.py"}
#: Files allowed to take `FOR UPDATE` (P57, final m2): the physical deletion of a norm or region row (Task 4) and
#: deleteField (Task 5).
ALLOWED: set[str] = {"modules/dictionaries/store.py", "modules/fields/services.py"}
PUBLISHERS = {"infra/relay.py", "events/tasks.py"}
FOR_UPDATE = re.compile(r"\bfor\s+update\b", re.I)
#: Task 10 review M2 — files where a float is the type by nature: the JS numbers of JSON bodies, of rendering and of
#: XLSX cells; the 1e21 threshold of JSON.stringify; a Pillow resampling factor; monotonic-clock seconds.
FLOAT_EXCEPTIONS = {"core/body.py", "core/render.py", "infra/xlsx_scan.py", "core/audit.py", "infra/images.py",
                    "infra/lanes.py", "modules/health/views.py"}
#: Names of durations in seconds (`CONFIRM_TIMEOUT_S`, `timeout=`, `connect_timeout`, `self._down_until`).
DURATION_NAME = re.compile(r"(_S|_until)$|timeout", re.I)


def sources():
    for p in sorted(PKG.rglob("*.py")):
        rel = p.relative_to(PKG).as_posix()
        yield rel, ast.parse(p.read_text("utf-8"), filename=rel)


def docstrings(tree) -> set[int]:
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                out.add(id(body[0].value))
    return out


def dotted(node) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{dotted(node.value)}.{node.attr}"
    return ""


def test_the_scan_sees_the_package():
    names = [rel for rel, _ in sources()]
    assert "core/tx.py" in names and "core/locks.py" in names and len(names) > 20


def test_no_process_or_statement_clock_in_written_data():
    bad = []
    for rel, tree in sources():
        if rel.split("/")[0] not in CLOCK_DIRS or rel in CLOCK_EXCEPTIONS:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = dotted(node.func)
                if name.split(".")[-1] == "Now" or name in ("timezone.now", "datetime.now", "date.today",
                                                              "datetime.datetime.now", "datetime.date.today",
                                                              "django.utils.timezone.now"):
                    bad.append(f"{rel}:{node.lineno} {name}()")
                for kw in node.keywords:
                    if kw.arg in ("auto_now", "auto_now_add"):
                        bad.append(f"{rel}:{node.lineno} {kw.arg}")
            if isinstance(node, ast.ImportFrom) and node.module == "django.db.models.functions":
                if any(a.name == "Now" for a in node.names):
                    bad.append(f"{rel}:{node.lineno} import Now")
    assert bad == []


def test_lock_strength():
    bad = []
    for rel, tree in sources():
        skip = docstrings(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and dotted(node.func).split(".")[-1] == "select_for_update":
                if not any(kw.arg == "no_key" and isinstance(kw.value, ast.Constant) and kw.value.value is True
                           for kw in node.keywords):
                    bad.append(f"{rel}:{node.lineno} select_for_update without no_key=True")
            if isinstance(node, ast.Call) and dotted(node.func).split(".")[-1] == "lock" and rel not in ALLOWED:
                for kw in node.keywords:
                    if kw.arg == "strength" and isinstance(kw.value, ast.Constant) and kw.value.value == "update":
                        bad.append(f"{rel}:{node.lineno} lock(strength='update')")
            if (isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip
                    and FOR_UPDATE.search(node.value) and rel not in ALLOWED):
                bad.append(f"{rel}:{node.lineno} FOR UPDATE in SQL")
    assert bad == []


def test_events_are_published_only_by_the_relay():
    bad = []
    for rel, tree in sources():
        if rel in PUBLISHERS:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and \
                    node.func.attr in ("delay", "apply_async", "retry"):
                bad.append(f"{rel}:{node.lineno} .{node.func.attr}()")
    assert bad == []


def test_the_guards_catch_what_they_guard(tmp_path):
    sample = ast.parse(
        "x.select_for_update()\nq = 'SELECT 1 FOR  Update'\nModels.DateTimeField(auto_now=True)\n"
        "datetime.now()\ntask.delay(1)\n"
    )
    calls = [dotted(n.func) for n in ast.walk(sample) if isinstance(n, ast.Call)]
    assert {"x.select_for_update", "datetime.now", "task.delay"} <= set(calls)
    assert FOR_UPDATE.search("SELECT 1 FOR  Update") and not FOR_UPDATE.search("FOR NO KEY UPDATE")


def test_for_update_is_taken_in_exactly_the_two_allowed_places():
    """P57 (Task 10): ALLOWED is exactly the dictionary row deletion and deleteField, and each of them really takes
    `FOR UPDATE` in a SQL string (a stale entry would silently widen the guard); nothing else in the package does."""
    assert ALLOWED == {"modules/dictionaries/store.py", "modules/fields/services.py"}
    found: set[str] = set()
    for rel, tree in sources():
        skip = docstrings(tree)
        for node in ast.walk(tree):
            if (isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip
                    and FOR_UPDATE.search(node.value)):
                found.add(rel)
    assert found == ALLOWED


def test_no_float_in_decimal_arithmetic():
    """Masses, lab values, norms and the trust rating are exact decimals or integers: over the WHOLE package (Task 10
    review M2) no `float(` call and no float literal, except
    - FLOAT_EXCEPTIONS — files whose numbers are JS numbers or clock seconds by nature;
    - a float literal that is a duration in seconds: the value of a name, attribute, keyword, parameter default or dict
      key named like a duration (DURATION_NAME: `*_S`, `*timeout*`, …)."""
    bad = []
    for rel, tree in sources():
        if rel in FLOAT_EXCEPTIONS:
            continue
        durations: set[int] = set()
        for node in ast.walk(tree):
            pairs: list[tuple[str, ast.AST]] = []
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                pairs += [(t.id if isinstance(t, ast.Name) else t.attr, node.value) for t in targets
                          if isinstance(t, (ast.Name, ast.Attribute)) and node.value is not None]
            elif isinstance(node, ast.keyword) and node.arg:
                pairs.append((node.arg, node.value))
            elif isinstance(node, ast.arguments):
                args = [*node.posonlyargs, *node.args]
                pairs += list(zip([a.arg for a in args[len(args) - len(node.defaults):]], node.defaults, strict=True))
                pairs += [(a.arg, d) for a, d in zip(node.kwonlyargs, node.kw_defaults, strict=True) if d is not None]
            elif isinstance(node, ast.Dict):
                pairs += [(k.value, v) for k, v in zip(node.keys, node.values, strict=True)
                          if isinstance(k, ast.Constant) and isinstance(k.value, str)]
            durations |= {id(v) for name, v in pairs if DURATION_NAME.search(name)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and dotted(node.func) == "float":
                bad.append(f"{rel}:{node.lineno} float()")
            if isinstance(node, ast.Constant) and isinstance(node.value, float) and id(node) not in durations:
                bad.append(f"{rel}:{node.lineno} float literal")
    assert bad == []
    assert {"domain/rules.py", "modules/rating/services.py", "modules/recalls/engine.py"} <= \
        {rel for rel, _ in sources()}


#: Task 11 review N4 — `a / b` and `math.*` / `statistics.*` give floats without any `float(` or float literal. The
#: allowed forms (everything else fails the guard): a path join (`ROOT / 'contracts'`: a str or f-string operand, or a
#: left operand named `ROOT`, `DIST` or `files`), and a millisecond setting converted to seconds (`…_MS / 1000`,
#: `timeout_ms / 1000`, `base_ms * … / 1000`). FLOAT_EXCEPTIONS files are skipped as above. Review M4: exact AST
#: shapes, not text patterns. Decimal division (`Decimal / Decimal` stays exact) is not used today; a future one is
#: added here by file with its reason, never by widening the shapes.
DIV_ALLOWED: dict[str, str] = {}
_PATH_NAMES = {"ROOT", "DIST", "files"}


def _last_name(node: ast.AST) -> str | None:
    """`x` of a Name, `y` of an Attribute `….y`; None for anything else (calls, subscripts, expressions)."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _is_ms(node: ast.AST) -> bool:
    """A millisecond setting: a Name/Attribute ending in `_ms`/`_MS`, or such a name times something (`base_ms * …`)."""
    name = _last_name(node)
    if name is not None:
        return name.endswith(("_ms", "_MS"))
    return isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult) and _is_ms(node.left)


def _allowed_div(node: ast.BinOp) -> bool:
    """`… / 'str'` or `… / f'…'` (a path join), `ROOT|DIST|files / …` (a Name or Attribute with that last name),
    a chain of those, `<ms setting> / 1000`."""
    left, right = node.left, node.right
    if isinstance(right, ast.JoinedStr) or (isinstance(right, ast.Constant) and isinstance(right.value, str)):
        return True
    if _last_name(left) in _PATH_NAMES:
        return True
    if isinstance(left, ast.BinOp) and isinstance(left.op, ast.Div) and _allowed_div(left):
        return True  # ROOT / 'a' / b
    return isinstance(right, ast.Constant) and right.value == 1000 and _is_ms(left)


def numeric_offences(rel: str, tree: ast.AST) -> list[str]:
    bad = []
    for node in ast.walk(tree):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div) and not _allowed_div(node):
            bad.append(f"{rel}:{node.lineno} division {ast.unparse(node)}")
        if isinstance(node, ast.AugAssign) and isinstance(node.op, ast.Div):
            bad.append(f"{rel}:{node.lineno} /= {ast.unparse(node)}")
        if isinstance(node, ast.Call) and dotted(node.func).split(".")[0] in ("math", "statistics"):
            bad.append(f"{rel}:{node.lineno} {dotted(node.func)}()")
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [node.module] if isinstance(node, ast.ImportFrom) else [a.name for a in node.names]
            if any(n in ("math", "statistics") for n in names):
                bad.append(f"{rel}:{node.lineno} import {', '.join(n for n in names if n)}")
    return bad


def test_no_true_division_or_math_in_numeric_code():
    bad = []
    for rel, tree in sources():
        if rel in FLOAT_EXCEPTIONS or rel in DIV_ALLOWED:
            continue
        bad += numeric_offences(rel, tree)
    assert bad == []


def test_the_division_guard_catches_what_it_guards():
    sample = ast.parse(
        "a = mass / count\nb = ROOT / 'x' / f'{y}.json'\nc = config.get().X_MS / 1000\nimport math\n"
        "d = math.floor(x)\ne = total\ne /= 3\nf = statistics.mean(xs)\ng = n // 2\nh = base_ms * 2 ** k / 1000\n"
        "i = Path(p).stat().st_size / n\nj = f(x_ms) / 1000\nk = total_ms / 3\nl = Path(ROOT) / 'a'\n")
    found = sorted(numeric_offences("sample.py", sample), key=lambda f: int(f.split(":")[1].split(" ")[0]))
    assert [f.split(" ", 1)[1].split(" ")[0] for f in found] == ["division", "import", "math.floor()", "/=",
                                                                  "statistics.mean()", "division", "division",
                                                                  "division"]
