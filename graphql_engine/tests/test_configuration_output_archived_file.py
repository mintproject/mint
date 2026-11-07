"""modelcatalog_configuration_output.archived_file: migration and Hasura permissions."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
TABLES = ROOT / "graphql_engine" / "metadata" / "tables.yaml"
MIGRATION = (
    ROOT / "graphql_engine" / "migrations" / "1771300000038_configuration_output_archived_file"
)
JUNCTION = "modelcatalog_configuration_output"


def _junction_entry():
    for entry in yaml.safe_load(TABLES.read_text()):
        table = entry["table"]
        if table.get("schema") == "public" and table["name"] == JUNCTION:
            return entry
    raise AssertionError(f"{JUNCTION} is not tracked")


def test_migration_adds_nullable_column_with_comment():
    up = (MIGRATION / "up.sql").read_text()
    assert f"ALTER TABLE {JUNCTION}" in up
    assert "ADD COLUMN archived_file TEXT;" in up
    assert "NOT NULL" not in up
    assert f"COMMENT ON COLUMN {JUNCTION}.archived_file" in up


def test_migration_down_drops_column():
    down = (MIGRATION / "down.sql").read_text()
    assert f"ALTER TABLE {JUNCTION}" in down
    assert "DROP COLUMN archived_file;" in down


def test_user_insert_and_select_and_anonymous_select_list_the_column():
    entry = _junction_entry()
    insert = {p["role"]: p for p in entry["insert_permissions"]}
    select = {p["role"]: p for p in entry["select_permissions"]}
    assert "archived_file" in insert["user"]["permission"]["columns"]
    assert "archived_file" in select["user"]["permission"]["columns"]
    assert "archived_file" in select["anonymous"]["permission"]["columns"]


def test_column_follows_output_id_in_both_lists():
    entry = _junction_entry()
    lists = [
        entry["insert_permissions"][0]["permission"]["columns"],
        next(p for p in entry["select_permissions"] if p["role"] == "anonymous")["permission"]["columns"],
    ]
    for cols in lists:
        assert cols.index("archived_file") == cols.index("output_id") + 1
