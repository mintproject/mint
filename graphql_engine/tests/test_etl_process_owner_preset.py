"""Role `user` cannot choose the owner of an ETL process, can only add contracts
to a process it owns, and can delete only a process it owns."""
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


def _user_permissions(name, kind):
    for entry in yaml.safe_load(TABLES.read_text()):
        if entry["table"] == {"name": name, "schema": "public"}:
            return [p["permission"] for p in entry.get(kind) or [] if p["role"] == "user"]
    raise AssertionError(f"{name} is not tracked")


def test_only_the_owner_can_delete_a_process():
    (perm,) = _user_permissions("modelcatalog_etl_process", "delete_permissions")
    assert perm["filter"] == {"owner_username": {"_eq": "X-Hasura-User-Id"}}


def test_a_process_cannot_be_edited_in_place_or_have_contracts_removed_alone():
    # A changed piece is a new piece: approval and plans are pinned to the source.
    assert _user_permissions("modelcatalog_etl_process", "update_permissions") == []
    for kind in ("update_permissions", "delete_permissions"):
        assert _user_permissions("modelcatalog_etl_process_contract", kind) == []


def test_deleting_a_process_removes_its_contracts():
    up = (ROOT / "migrations" / "1771200020000_modelcatalog_etl_process" / "up.sql").read_text()
    assert "REFERENCES modelcatalog_etl_process(id) ON DELETE CASCADE" in up


def test_migration_adds_and_removes_the_same_columns():
    up = (MIGRATION / "up.sql").read_text()
    down = (MIGRATION / "down.sql").read_text()
    for column in ("owner_username", "visibility", "mint_etl_process_id", "approved_source_sha256"):
        assert f"ADD COLUMN {column}" in up
        assert f"DROP COLUMN IF EXISTS {column}" in down
