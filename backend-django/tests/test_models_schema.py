"""Every `managed = False` model matches the dbmate schema of agrotrace_test_django: its table exists and each field
is a column of a compatible type and nullability (grows with every task that adds models)."""

from django.apps import apps
from django.db import connection, models

TYPES = {
    models.BigAutoField: "bigint",
    models.AutoField: "integer",
    models.BigIntegerField: "bigint",
    models.IntegerField: "integer",
    models.SmallIntegerField: "smallint",
    models.PositiveIntegerField: "integer",
    models.UUIDField: "uuid",
    models.CharField: "character varying",
    models.TextField: "text",
    models.BooleanField: "boolean",
    models.DateTimeField: "timestamp with time zone",
    models.DateField: "date",
    models.DecimalField: "numeric",
    models.FloatField: "double precision",
    models.JSONField: "jsonb",
    models.GenericIPAddressField: "inet",
    models.BinaryField: "bytea",
}


def expected_type(field) -> str:
    if isinstance(field, models.ForeignKey):
        return expected_type(field.target_field)
    for cls in type(field).__mro__:
        if cls in TYPES:
            return TYPES[cls]
    raise AssertionError(f"no type mapping for {type(field).__name__}")


def unmanaged():
    return [m for m in apps.get_models() if not m._meta.managed]


def test_there_are_models_to_check():
    assert {m._meta.db_table for m in unmanaged()} >= {"audit_log", "outbox_events", "processed_events"}


def test_every_field_is_a_column_of_a_compatible_type(db):
    with connection.cursor() as cur:
        cur.execute(
            "SELECT table_name, column_name, data_type, is_nullable, character_maximum_length "
            "FROM information_schema.columns WHERE table_schema = 'public'"
        )
        columns = {(t, c): (dt, nul == "YES", ml) for t, c, dt, nul, ml in cur.fetchall()}
    problems = []
    for model in unmanaged():
        table = model._meta.db_table
        if not any(t == table for t, _ in columns):
            problems.append(f"{model.__name__}: table {table} does not exist")
            continue
        for field in model._meta.concrete_fields:
            col = columns.get((table, field.column))
            if col is None:
                problems.append(f"{table}.{field.column}: no such column")
                continue
            data_type, nullable, max_len = col
            if data_type != expected_type(field):
                problems.append(f"{table}.{field.column}: {data_type} != {expected_type(field)}")
            if nullable != field.null:
                problems.append(f"{table}.{field.column}: nullable {nullable} != null={field.null}")
            if isinstance(field, models.CharField) and field.max_length != max_len:
                problems.append(f"{table}.{field.column}: varchar({max_len}) != max_length={field.max_length}")
    assert problems == []
