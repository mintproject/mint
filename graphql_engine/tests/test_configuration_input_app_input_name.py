"""modelcatalog_configuration_input.app_input_name: migration and Hasura permissions."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
TABLES = ROOT / "graphql_engine" / "metadata" / "tables.yaml"
MIGRATION = (
    ROOT / "graphql_engine" / "migrations" / "1771300000037_configuration_input_app_input_name"
)
JUNCTION = "modelcatalog_configuration_input"


def _junction_entry():
    for entry in yaml.safe_load(TABLES.read_text()):
        table = entry["table"]
        if table.get("schema") == "public" and table["name"] == JUNCTION:
            return entry
    raise AssertionError(f"{JUNCTION} is not tracked")


def test_migration_adds_nullable_column_with_comment():
    up = (MIGRATION / "up.sql").read_text()
    assert f"ALTER TABLE {JUNCTION}" in up
    assert "ADD COLUMN app_input_name TEXT;" in up
    assert "NOT NULL" not in up
    assert f"COMMENT ON COLUMN {JUNCTION}.app_input_name" in up


def test_migration_down_drops_column():
    down = (MIGRATION / "down.sql").read_text()
    assert f"ALTER TABLE {JUNCTION}" in down
    assert "DROP COLUMN app_input_name;" in down


def test_user_insert_and_select_and_anonymous_select_list_the_column():
    entry = _junction_entry()
    insert = {p["role"]: p for p in entry["insert_permissions"]}
    select = {p["role"]: p for p in entry["select_permissions"]}
    assert "app_input_name" in insert["user"]["permission"]["columns"]
    assert "app_input_name" in select["user"]["permission"]["columns"]
    assert "app_input_name" in select["anonymous"]["permission"]["columns"]


def test_column_sits_beside_is_optional_in_both_lists():
    entry = _junction_entry()
    lists = [
        entry["insert_permissions"][0]["permission"]["columns"],
        next(p for p in entry["select_permissions"] if p["role"] == "anonymous")["permission"]["columns"],
    ]
    for cols in lists:
        assert cols.index("app_input_name") == cols.index("is_optional") + 1
