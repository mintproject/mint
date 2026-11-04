"""Every column the secrets-store GraphQL strings select or write must exist in
the migrations, so a wrong column name can never ship silently (a Hasura
validation error only shows up against a real database)."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import hasura, main  # noqa: E402

MIGRATIONS = Path(__file__).resolve().parents[2] / "graphql_engine" / "migrations"


def _migration(name: str) -> str:
    return (MIGRATIONS / name / "up.sql").read_text()


def _create_table_columns(sql: str, table: str) -> set[str]:
    """Column names from ``CREATE TABLE <table> ( ... )`` (top-level lines only)."""
    match = re.search(rf"CREATE TABLE\s+(?:IF NOT EXISTS\s+)?{re.escape(table)}\s*\(", sql)
    assert match, f"CREATE TABLE {table} not found"
    depth, i, body_start = 1, match.end(), match.end()
    while depth:
        depth += {"(": 1, ")": -1}.get(sql[i], 0)
        i += 1
    body = re.sub(r"--[^\n]*", "", sql[body_start:i - 1])
    columns: set[str] = set()
    depth = 0
    item = ""
    for ch in body + ",":
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            first = item.split()[0] if item.split() else ""
            if first.upper() not in {"", "CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"}:
                columns.add(first.strip('"'))
            item = ""
        else:
            item += ch
    return columns


def _added_columns(table: str, *migration_names: str) -> set[str]:
    cols: set[str] = set()
    for name in migration_names:
        for alter in re.finditer(rf"ALTER TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?{re.escape(table.removeprefix('public.'))}\b(.*?);",
                                 _migration(name), re.S | re.I):
            cols |= set(re.findall(r"ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)", alter.group(1), re.I))
    return cols


def _block_fields(query: str, opener: str) -> set[str]:
    """Scalar field names selected directly inside the first ``opener { ... }``."""
    start = query.index(opener) + len(opener)
    start = query.index("{", start) + 1
    depth, i, fields, token = 1, start, set(), ""
    while depth:
        ch = query[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif depth == 1 and (ch.isalnum() or ch == "_"):
            token += ch
            i += 1
            continue
        if token and depth == 1 and ch != "{":
            fields.add(token)
        token = ""
        i += 1
    return fields


PARAMETER = _create_table_columns(_migration("1771105509000_modelcatalog_schema"),
                                  "modelcatalog_parameter") | _added_columns(
    "modelcatalog_parameter", "1771200002000_modelcatalog_parameter_accepted_values")
SECRET_SQL = _migration("1771300000036_adapter_secret")
SECRET = _create_table_columns(SECRET_SQL, "adapter.secret")
SECRET_EVENT = _create_table_columns(SECRET_SQL, "adapter.secret_event")
RUN_ADDED = _added_columns("adapter.workflow_run", "1771300000036_adapter_secret")
CONFIGURATION_ADDED = _added_columns(
    "public.modelcatalog_configuration", "1771200026000_modelcatalog_configuration_ownership",
    "1771300000017_svo_adapter_sync_schema")


def test_the_migration_parser_reads_known_columns():
    assert {"id", "label", "parameter_type", "has_accepted_values"} <= PARAMETER
    assert "usage_notes" not in PARAMETER
    assert {"ciphertext", "configuration_ref", "fields", "last_used_at"} <= SECRET
    assert {"secret_id", "event", "secret_version", "actor_token_kind"} <= SECRET_EVENT


def test_secret_configuration_query_selects_only_real_parameter_columns():
    selected = _block_fields(hasura.GET_SECRET_CONFIGURATION, "parameter ")
    assert selected, "parser found nothing under parameter { }"
    assert selected <= PARAMETER, f"unknown parameter columns: {selected - PARAMETER}"


def test_secret_configuration_query_selects_only_real_configuration_columns():
    top = _block_fields(hasura.GET_SECRET_CONFIGURATION, "modelcatalog_configuration_by_pk(id: $id)")
    top -= {"parameters"}
    assert {"id"} | CONFIGURATION_ADDED >= top, top


def test_secret_queries_select_only_real_adapter_secret_columns():
    meta = set(hasura._SECRET_META.split())
    assert meta <= SECRET, meta - SECRET
    assert {"ciphertext"} <= SECRET
    for query in (hasura.FIND_SECRET, hasura.GET_SECRET, hasura.LIST_SECRETS,
                  hasura.INSERT_SECRET, hasura.UPDATE_SECRET):
        for name in re.findall(r"\b(owner_username|configuration_id|scope|name)\s*:\s*\{", query):
            assert name in SECRET


def test_run_credential_queries_use_the_added_workflow_run_columns():
    assert {"bound_secrets", "credentials_issued"} <= RUN_ADDED
    for query in (main.GET_RUN_CREDENTIALS, main.ISSUE_RUN_CREDENTIALS_IF):
        used = set(re.findall(r"\b(bound_secrets|credentials_issued)\b", query))
        assert used <= RUN_ADDED
    assert "bound_secrets" in main.GET_RUN_CREDENTIALS and "credentials_issued" in main.GET_RUN_CREDENTIALS


def test_secret_event_rows_written_by_the_store_use_real_columns():
    import inspect
    from app import secrets as secrets_store
    source = inspect.getsource(secrets_store.record_event)
    keys = set(re.findall(r'"(\w+)":', source)) - {"obj"}  # "obj" is the GraphQL variable
    assert keys, "record_event builds no row dict"
    assert keys <= SECRET_EVENT, f"unknown secret_event columns: {keys - SECRET_EVENT}"
