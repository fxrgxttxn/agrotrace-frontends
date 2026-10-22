"""
Static guards over agrotrace/ (Review Focus 1, 2, 5), on the AST — comments and docstrings do not count, SQL strings
do:
- P43: no process clock and no statement clock in written data and deadline rules — `Now()` (STATEMENT_TIMESTAMP),
  `auto_now`/`auto_now_add`, `timezone.now()`, `datetime.now()`, `date.today()` in modules/, events/, scheduler/,
  core/ (exceptions: the files below, whose clock is not written data);
- P57: no `select_for_update()` without `no_key=True`, no `FOR UPDATE` in SQL and no `lock(..., strength='update')`
  outside ALLOWED (dictionary row deletion — Task 4, deleteField — Task 5);
- outbox only (R55): no `.delay()`, `.apply_async()`, `.retry()` outside infra/relay.py and events/tasks.py.
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
