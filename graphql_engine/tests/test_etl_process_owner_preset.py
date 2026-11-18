"""Role `user` cannot choose the owner of an ETL process, and can only add
contracts to a process it owns."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
TABLES = ROOT / "metadata" / "tables.yaml"
MIGRATION = ROOT / "migrations" / "1771300000039_adapter_transform_spec_ownership"


def _user_insert(name):
    for entry in yaml.safe_load(TABLES.read_text()):
        if entry["table"] == {"name": name, "schema": "public"}:
            for perm in entry.get("insert_permissions") or []:
                if perm["role"] == "user":
                    return perm["permission"]
    raise AssertionError(f"{name} has no user insert permission")


def test_owner_is_preset_from_the_session_and_not_insertable():
    perm = _user_insert("modelcatalog_etl_process")
    assert perm["set"]["owner_username"].lower() == "x-hasura-user-id"
    assert "owner_username" not in perm["columns"]
    assert "visibility" in perm["columns"]


def test_contracts_require_owning_the_process():
    perm = _user_insert("modelcatalog_etl_process_contract")
    assert perm["check"] == {"etl_process": {"owner_username": {"_eq": "X-Hasura-User-Id"}}}


def test_migration_adds_and_removes_the_same_columns():
    up = (MIGRATION / "up.sql").read_text()
    down = (MIGRATION / "down.sql").read_text()
    for column in ("owner_username", "visibility", "mint_etl_process_id", "approved_source_sha256"):
        assert f"ADD COLUMN {column}" in up
        assert f"DROP COLUMN IF EXISTS {column}" in down
